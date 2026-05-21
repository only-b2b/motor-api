// api/routes/orders.js

import express           from "express";
import { pool }          from "../services/db.js";
import ngeohash          from "ngeohash";
import Razorpay          from "razorpay";
import crypto            from "crypto";
import multer            from "multer";
import path              from "path";
import { fileURLToPath } from "url";
import {
  sendRideRequestPush,
  sendRideConfirmedPush,
} from "../services/push.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const router = express.Router();

// ================================================================
// ==================== HELPERS ===================================
// ================================================================

const toNum = (val) => {
  if (val === null || val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
};

const parseNumeric = (value) => {
  if (!value) return null;
  if (typeof value === "number") return value;
  const match = String(value).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
};

const getCategoryVariants = (serviceType) => {
  if (!serviceType) return [];
  const s = serviceType.toLowerCase().trim();
  const variantMap = {
    driver:      ["driver"],
    car_wash:    ["car_wash", "carwash", "car-wash"],
    carwash:     ["car_wash", "carwash", "car-wash"],
    "car-wash":  ["car_wash", "carwash", "car-wash"],
    pickdrop:    ["pickdrop", "pick_drop", "driver"],
    pick_drop:   ["pickdrop", "pick_drop", "driver"],
    "pick-drop": ["pickdrop", "pick_drop", "driver"],
    ride:        ["ride", "driver", "pickdrop"],
  };
  return variantMap[s] || [s];
};

const getCalculateEarnings = async () => {
  const mod = await import("./earnings.js");
  return mod.calculateEarnings;
};

// ================================================================
// ==================== ALGORITHM 1: HAVERSINE ====================
// ================================================================
// Calculates real-world distance between two GPS coordinates
// Used by Uber/Ola to filter drivers within radius
// ================================================================

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a    =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // km
};

// ================================================================
// ==================== ALGORITHM 2: GEOHASH NEIGHBORS ============
// ================================================================
// Divides earth into hex cells — drivers in same/adjacent cells
// are "nearby". Core of Uber's H3 hexagonal grid system.
// Precision 6 = ~1.2km cell, Precision 5 = ~4.9km cell
// ================================================================

const getGeohashNeighbors = (lat, lng, precision = 6) => {
  const centerHash = ngeohash.encode(lat, lng, precision);
  const neighbors  = ngeohash.neighbors(centerHash);
  return [centerHash, ...Object.values(neighbors)]; // 9 cells total
};

// ================================================================
// ==================== ALGORITHM 3: DRIVER SCORING ===============
// ================================================================
// Multi-factor score to rank drivers (like Uber's matching engine)
// Factors: distance (50pts), rating (30pts), acceptance (10pts),
//          completion rate (10pts) = 100pts max
// ================================================================

const calculateDriverScore = (driver, pickupLat, pickupLng) => {
  const dLat   = parseFloat(driver.lat || 0);
  const dLng   = parseFloat(driver.lng || 0);
  const distKm = haversineDistance(pickupLat, pickupLng, dLat, dLng);

  const distanceScore    = Math.max(0, 50 - distKm * 5);
  const ratingScore      = ((parseFloat(driver.rating) || 4.0) / 5) * 30;
  const acceptanceScore  = ((parseFloat(driver.acceptance_rate) || 80) / 100) * 10;
  const completionScore  = ((parseFloat(driver.completion_rate) || 95) / 100) * 10;
  const totalScore       = distanceScore + ratingScore + acceptanceScore + completionScore;

  return {
    score:          Math.round(totalScore * 10) / 10,
    distKm:         Math.round(distKm * 10) / 10,
    distanceScore:  Math.round(distanceScore),
    ratingScore:    Math.round(ratingScore),
    acceptanceScore: Math.round(acceptanceScore),
    completionScore: Math.round(completionScore),
  };
};

// ================================================================
// ==================== ALGORITHM 4: WAVE DISPATCH ================
// ================================================================
// Rapido/Uber dispatch in expanding radius waves:
// Wave 1: 0-2km  → top 3 drivers → wait 20s
// Wave 2: 0-5km  → top 5 drivers → wait 30s
// Wave 3: 0-10km → top 10 drivers → wait 40s
// Wave 4: 0-15km → top 20 drivers → wait 60s
// ================================================================

const DISPATCH_WAVES = [
  { radiusKm: 2,  maxDrivers: 3,  waitSeconds: 20, label: "Wave 1 — Hyperlocal" },
  { radiusKm: 5,  maxDrivers: 5,  waitSeconds: 30, label: "Wave 2 — Local"      },
  { radiusKm: 10, maxDrivers: 10, waitSeconds: 40, label: "Wave 3 — City"       },
  { radiusKm: 15, maxDrivers: 20, waitSeconds: 60, label: "Wave 4 — Extended"   },
];

// ================================================================
// ==================== ALGORITHM 5: FIND NEARBY DRIVERS ==========
// ================================================================
// Combines Geohash + Haversine + Scoring for smart discovery:
// Step 1 → Geohash: fast candidate lookup from DB (indexed)
// Step 2 → Haversine: exact radius filter
// Step 3 → Score & sort: best drivers first
// Step 4 → Slice: return top N for this wave
// ================================================================

const findNearbyDrivers = async (
  pickupLat,
  pickupLng,
  categoryVariants,
  radiusKm,
  maxDrivers,
  alreadyNotified = []
) => {
  const geohashPrecision = radiusKm <= 3 ? 6 : 5;
  const nearbyHashes     = getGeohashNeighbors(pickupLat, pickupLng, geohashPrecision);

  console.log(`\n🔍 findNearbyDrivers | radius: ${radiusKm}km | cells: ${nearbyHashes.length}`);

  // Query drivers in nearby geohash cells with real-time location
  const { rows: candidates } = await pool.query(
    `SELECT DISTINCT ON (t.id)
       t.id,
       t.full_name,
       t.phone,
       t.push_token,
       t.rating,
       t.acceptance_rate,
       t.completion_rate,
       t.category,
       dl.lat,
       dl.lng,
       dl.geohash,
       dl.updated_at AS location_updated_at
     FROM technicians t
     INNER JOIN driver_locations dl ON dl.technician_id = t.id
     WHERE t.category      = ANY($1::text[])
       AND t.is_available  = true
       AND t.push_token    IS NOT NULL
       AND dl.geohash      = ANY($2::text[])
       AND dl.updated_at   > NOW() - INTERVAL '10 minutes'
       AND t.id            != ALL($3::int[])
     ORDER BY t.id, dl.updated_at DESC`,
    [
      categoryVariants,
      nearbyHashes,
      alreadyNotified.length > 0 ? alreadyNotified : [0],
    ]
  );

  console.log(`   Geohash candidates: ${candidates.length}`);

  // Exact haversine filter + scoring
  const scoredDrivers = candidates
    .map((driver) => {
      const dLat = parseFloat(driver.lat);
      const dLng = parseFloat(driver.lng);
      if (!dLat || !dLng) return null;

      const distKm = haversineDistance(pickupLat, pickupLng, dLat, dLng);
      if (distKm > radiusKm) return null;

      const scoreData = calculateDriverScore(driver, pickupLat, pickupLng);
      return { ...driver, distKm: scoreData.distKm, score: scoreData.score, scoreData };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxDrivers);

  console.log(`   After filter: ${scoredDrivers.length} drivers within ${radiusKm}km`);
  scoredDrivers.forEach((d) => {
    console.log(`   → [${d.id}] ${d.full_name} | dist: ${d.distKm}km | score: ${d.score}`);
  });

  return scoredDrivers;
};

// ================================================================
// ==================== ALGORITHM 6: WAVE ORCHESTRATOR ============
// ================================================================
// Runs as background job — checks order status between waves,
// stops when accepted/cancelled, expands radius each wave
// ================================================================

const runWaveDispatch = async (orderId, pickupLat, pickupLng, serviceType) => {
  const categoryVariants  = getCategoryVariants(serviceType);
  const notifiedDriverIds = [];

  console.log(`\n🌊 WAVE DISPATCH START | Order ${orderId} | ${serviceType}`);

  for (let waveIndex = 0; waveIndex < DISPATCH_WAVES.length; waveIndex++) {
    const wave = DISPATCH_WAVES[waveIndex];

    // Check order is still active before each wave
    const orderCheck = await pool.query(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId]
    );

    if (!orderCheck.rows.length) {
      console.log(`   ⚠️  Order ${orderId} not found — stopping`);
      break;
    }

    const currentStatus = orderCheck.rows[0].status;
    if (currentStatus !== "requested") {
      console.log(`   ✅ Order ${orderId} → '${currentStatus}' — stopping dispatch`);
      break;
    }

    console.log(`\n   ${wave.label} | radius: ${wave.radiusKm}km | max: ${wave.maxDrivers}`);

    const nearbyDrivers = await findNearbyDrivers(
      pickupLat, pickupLng,
      categoryVariants,
      wave.radiusKm,
      wave.maxDrivers,
      notifiedDriverIds
    );

    if (nearbyDrivers.length === 0) {
      console.log(`   ⚠️  No new drivers in wave ${waveIndex + 1}`);
      if (waveIndex === DISPATCH_WAVES.length - 1) {
        console.log(`   ❌ No drivers found after all waves for Order ${orderId}`);
        await pool.query(
          `UPDATE orders SET dispatch_status='no_drivers', updated_at=NOW() WHERE id=$1`,
          [orderId]
        ).catch(() => {});
      }
      continue;
    }

    // Fetch fresh order data for push payload
    const orderData = await pool.query(
      `SELECT id, service_type, price, customer_total,
              pickup_address, drop_address, payment_method,
              is_scheduled, scheduled_date, distance, duration
       FROM orders WHERE id = $1`,
      [orderId]
    );
    if (!orderData.rows.length) break;
    const order = orderData.rows[0];

    let sentInWave = 0;
    for (const driver of nearbyDrivers) {
      try {
        await sendRideRequestPush(driver.push_token, {
          ...order,
          price:          toNum(order.customer_total || order.price),
          driverDistance: driver.distKm,
          estimatedTime:  Math.round(driver.distKm * 3),
        });
        notifiedDriverIds.push(driver.id);
        sentInWave++;
        console.log(`   📱 Push → ${driver.full_name} | ${driver.distKm}km | score: ${driver.score}`);
      } catch (pushErr) {
        console.error(`   ❌ Push failed for ${driver.full_name}:`, pushErr.message);
      }
    }

    console.log(`   📊 Wave ${waveIndex + 1}: ${sentInWave}/${nearbyDrivers.length} sent`);

    // Wait before next wave
    if (waveIndex < DISPATCH_WAVES.length - 1) {
      console.log(`   ⏳ Waiting ${wave.waitSeconds}s...`);
      await new Promise((resolve) => setTimeout(resolve, wave.waitSeconds * 1000));
    }
  }

  console.log(`\n🌊 WAVE DISPATCH END | Order ${orderId} | Total notified: ${notifiedDriverIds.length}\n`);
};

// ================================================================
// ==================== ALGORITHM 7: MUTEX LOCK ===================
// ================================================================
// Three-layer protection against duplicate acceptance:
// Layer 1 → In-memory mutex (instant, no DB round trip)
// Layer 2 → PostgreSQL FOR UPDATE NOWAIT (row-level DB lock)
// Layer 3 → Status check (final guard)
// ================================================================

const acceptingOrders = new Map();

const acquireOrderLock = (orderId) => {
  if (acceptingOrders.has(orderId)) return false;
  acceptingOrders.set(orderId, Date.now());
  return true;
};

const releaseOrderLock = (orderId) => {
  acceptingOrders.delete(orderId);
};

// Clean stale locks every 30s
setInterval(() => {
  const now   = Date.now();
  const stale = 30000;
  for (const [orderId, timestamp] of acceptingOrders.entries()) {
    if (now - timestamp > stale) {
      acceptingOrders.delete(orderId);
      console.log(`🔓 Released stale lock for order ${orderId}`);
    }
  }
}, 30000);

// ================================================================
// ==================== MULTER ====================================
// ================================================================

const storage = multer.diskStorage({
  destination: (_req, _file, cb) =>
    cb(null, path.join(__dirname, "../uploads")),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".jpg");
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  },
});
const upload = multer({ storage });

// ================================================================
// ==================== UPLOAD PHOTOS =============================
// ================================================================

router.post("/:id/upload-photos", upload.array("photos", 10), async (req, res) => {
  try {
    const host = `${req.protocol}://${req.get("host")}`;
    const urls = (req.files || []).map((f) => `${host}/uploads/${f.filename}`);
    res.json({ urls });
  } catch (e) {
    res.status(500).json({ error: "Upload failed" });
  }
});

// ================================================================
// ==================== DEBUG ENDPOINT ============================
// ================================================================

router.get("/debug/flow", async (req, res) => {
  const { service_type = "driver", lat, lng } = req.query;
  try {
    const categoryVariants = getCategoryVariants(service_type);

    let geohashDebug = null;
    if (lat && lng) {
      const hashes = getGeohashNeighbors(parseFloat(lat), parseFloat(lng), 6);
      geohashDebug = {
        center_hash:     hashes[0],
        neighbor_hashes: hashes.slice(1),
        total_cells:     hashes.length,
        coverage:        "~3.6km radius",
      };
    }

    const techs = await pool.query(
      `SELECT
         t.id, t.full_name, t.category, t.is_available,
         CASE WHEN t.push_token IS NOT NULL THEN true ELSE false END AS has_push_token,
         t.current_order_id, t.firebase_uid, t.rating,
         t.acceptance_rate, t.completion_rate,
         dl.lat, dl.lng, dl.geohash, dl.updated_at AS loc_updated
       FROM technicians t
       LEFT JOIN driver_locations dl ON dl.technician_id = t.id
       WHERE t.category = ANY($1::text[]) OR t.category IS NULL
       ORDER BY t.is_available DESC`,
      [categoryVariants]
    );

    const allTechs = await pool.query(
      `SELECT t.id, t.full_name, t.category, t.is_available,
              CASE WHEN t.push_token IS NOT NULL THEN true ELSE false END AS has_push_token,
              dl.lat, dl.lng, dl.updated_at AS loc_updated
       FROM technicians t
       LEFT JOIN driver_locations dl ON dl.technician_id = t.id
       ORDER BY t.id DESC LIMIT 20`
    );

    const pendingOrders = await pool.query(
      `SELECT id, status, service_type, created_at, payment_method,
              pickup_address, drop_address, pickup_lat, pickup_lng
       FROM orders
       WHERE status='requested' AND service_type=ANY($1::text[])
       ORDER BY created_at DESC LIMIT 10`,
      [categoryVariants]
    );

    const recentOrders = await pool.query(
      `SELECT id, status, service_type, created_at, payment_method
       FROM orders WHERE service_type=ANY($1::text[])
       ORDER BY created_at DESC LIMIT 10`,
      [categoryVariants]
    );

    const activeLocks = Array.from(acceptingOrders.entries()).map(([id, ts]) => ({
      orderId:   id,
      lockedFor: `${Math.round((Date.now() - ts) / 1000)}s`,
    }));

    res.json({
      searched:      { service_type, category_variants: categoryVariants },
      geohash_debug: geohashDebug,
      active_locks:  activeLocks,
      dispatch_waves: DISPATCH_WAVES,
      technicians_for_service: {
        total:           techs.rows.length,
        available:       techs.rows.filter((t) => t.is_available).length,
        with_push_token: techs.rows.filter((t) => t.has_push_token).length,
        with_location:   techs.rows.filter((t) => t.lat).length,
        list:            techs.rows,
      },
      all_technicians: { total: allTechs.rows.length, list: allTechs.rows },
      pending_orders:  { total: pendingOrders.rows.length, list: pendingOrders.rows },
      recent_orders:   { total: recentOrders.rows.length, list: recentOrders.rows },
      diagnosis: {
        no_technicians: techs.rows.length === 0
          ? `❌ No technicians for ${JSON.stringify(categoryVariants)}`
          : `✅ ${techs.rows.length} found`,
        not_available: techs.rows.filter((t) => t.is_available).length === 0
          ? "❌ None available"
          : `✅ ${techs.rows.filter((t) => t.is_available).length} available`,
        no_push_token: techs.rows.filter((t) => t.has_push_token).length === 0
          ? "❌ None have push token"
          : `✅ ${techs.rows.filter((t) => t.has_push_token).length} have push token`,
        no_location: techs.rows.filter((t) => t.lat).length === 0
          ? "❌ None have location — TechApp must POST /orders/technician-location"
          : `✅ ${techs.rows.filter((t) => t.lat).length} have location`,
        no_pending: pendingOrders.rows.length === 0
          ? "❌ No pending orders"
          : `✅ ${pendingOrders.rows.length} pending`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ==================== CREATE ORDER ==============================
// ================================================================

router.post("/", async (req, res) => {
  try {
    const {
      firebase_uid,
      address_id     = null,
      service_type,
      vehicle        = null,
      package_name   = null,
      hub            = null,
      distance       = null,
      duration       = null,
      price,
      payment        = "cash",
      payment_method = null,
      pickup_lat     = null,
      pickup_lng     = null,
      drop_lat       = null,
      drop_lng       = null,
      pickup         = null,
      drop           = null,
      pickup_address = null,
      drop_address   = null,
      car_details    = null,
      scheduled_date = null,
      is_scheduled   = false,
      pricing        = null,
      customer_total = null,
    } = req.body;

    const numericDistance    = parseNumeric(distance);
    const numericDuration    = parseNumeric(duration);
    const finalPickup        = pickup        || pickup_address;
    const finalDrop          = drop          || drop_address;
    const finalPaymentMethod = payment_method || payment || "cash";
    const finalCustomerTotal = customer_total || pricing?.customer_total || price;

    if (!firebase_uid || !service_type || price == null) {
      return res.status(400).json({
        error:    "Missing required fields",
        required: ["firebase_uid", "service_type", "price"],
      });
    }

    if (["driver", "pickdrop", "ride"].includes(service_type)) {
      if (!finalPickup || !finalDrop || !pickup_lat || !pickup_lng || !drop_lat || !drop_lng) {
        return res.status(400).json({
          error: `${service_type} requires complete pickup and drop information`,
        });
      }
    }

    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid=$1",
      [firebase_uid]
    );
    if (!userRes.rows.length)
      return res.status(404).json({ error: "User not found" });

    const userId = userRes.rows[0].id;

    if (!is_scheduled) {
      const activeRide = await pool.query(
        `SELECT id, status, service_type, created_at FROM orders
         WHERE user_id = $1
           AND status IN ('requested','accepted','arrived','in_progress')
           AND (is_scheduled = false OR is_scheduled IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (activeRide.rows.length > 0) {
        return res.status(409).json({
          error:       "ACTIVE_RIDE_EXISTS",
          message:     "You have an active booking.",
          activeOrder: activeRide.rows[0],
        });
      }
    }

    const platformCommission   = pricing?.platform_commission    || null;
    const platformFixedFee     = pricing?.platform_fixed_fee     || null;
    const totalPlatformEarning = pricing?.total_platform_earning || null;
    const gstOnCommission      = pricing?.gst_on_commission      || null;
    const driverEarning        = pricing?.driver_earning         || null;

    const orderRes = await pool.query(
      `INSERT INTO orders (
        user_id, address_id, service_type, vehicle, package_name,
        hub_name, distance, duration, price, customer_total,
        pickup_lat, pickup_lng, drop_lat, drop_lng,
        pickup_address, drop_address, payment_mode, payment_method,
        car_details, scheduled_date, is_scheduled,
        platform_commission, platform_fixed_fee, total_platform_earning,
        gst_on_commission, driver_earning, pricing_breakdown,
        status, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'created',NOW()
      ) RETURNING id, created_at`,
      [
        userId, address_id, service_type, vehicle, package_name,
        hub, numericDistance, numericDuration, price, finalCustomerTotal,
        pickup_lat, pickup_lng, drop_lat, drop_lng,
        finalPickup, finalDrop, finalPaymentMethod, finalPaymentMethod,
        car_details ? JSON.stringify(car_details) : null,
        scheduled_date || null,
        is_scheduled   || false,
        platformCommission, platformFixedFee, totalPlatformEarning,
        gstOnCommission, driverEarning,
        pricing ? JSON.stringify(pricing) : null,
      ]
    );

    const order = orderRes.rows[0];
    console.log(`✅ Order ${order.id} created | ${service_type} | ${finalPaymentMethod}`);
    if (is_scheduled) console.log(`   📅 Scheduled: ${scheduled_date}`);

    res.status(201).json({
      id:           order.id,
      created_at:   order.created_at,
      is_scheduled,
      message:      "Order created successfully",
    });
  } catch (err) {
    console.error("CREATE ORDER ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ================================================================
// ==================== FORCE RELEASE (DEV ONLY) ==================
// ================================================================

router.post("/:id/force-release", async (req, res) => {
  const id = Number(req.params.id);
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Not available in production" });
  }
  try {
    const result = await pool.query(
      `UPDATE orders
       SET status='requested', scheduled_released_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND is_scheduled=true AND status='created'
       RETURNING id, service_type, price, customer_total,
                 pickup_address, drop_address, payment_method,
                 pickup_lat, pickup_lng`,
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Order not found or not a scheduled order in 'created' status" });
    }
    const order    = result.rows[0];
    const variants = getCategoryVariants(order.service_type);

    const pickupLat = toNum(order.pickup_lat);
    const pickupLng = toNum(order.pickup_lng);

    let sent = 0;
    if (pickupLat && pickupLng) {
      setImmediate(() => {
        runWaveDispatch(id, pickupLat, pickupLng, order.service_type)
          .catch((err) => console.error(`Wave dispatch error for order ${id}:`, err.message));
      });
      sent = -1; // Wave dispatch running async
    } else {
      const { rows: drivers } = await pool.query(
        `SELECT id, push_token, full_name FROM technicians
         WHERE category=ANY($1::text[]) AND is_available=true AND push_token IS NOT NULL`,
        [variants]
      );
      for (const driver of drivers) {
        try {
          await sendRideRequestPush(driver.push_token, { ...order, is_scheduled: true });
          sent++;
        } catch (e) {
          console.error(`Push failed for ${driver.full_name}:`, e.message);
        }
      }
    }

    console.log(`🔧 Force-released order ${id}`);
    res.json({
      success:          true,
      orderId:          id,
      status:           "requested",
      drivers_notified: sent === -1 ? "wave dispatch running" : sent,
      message:          sent === -1 ? "Wave dispatch started" : `${sent} driver(s) notified`,
    });
  } catch (err) {
    console.error("FORCE RELEASE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ==================== UPCOMING RIDES FOR DRIVER =================
// ================================================================

router.get("/upcoming/by-technician", async (req, res) => {
  const { technician_id } = req.query;
  if (!technician_id)
    return res.status(400).json({ error: "technician_id required" });

  try {
    const result = await pool.query(
      `SELECT
        o.id, o.service_type, o.status, o.distance, o.duration,
        o.price, o.customer_total, o.payment_method,
        o.pickup_address, o.drop_address,
        o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng,
        o.vehicle, o.car_details, o.otp,
        o.is_scheduled, o.scheduled_date,
        o.accepted_at, o.created_at,
        u.name  AS client_name,
        u.phone AS client_phone
       FROM orders o
       JOIN order_technicians ot ON ot.order_id = o.id
       JOIN users u ON u.id = o.user_id
       WHERE ot.technician_id = $1
         AND o.status = 'accepted'
         AND o.is_scheduled = true
         AND o.scheduled_date > NOW()
       ORDER BY o.scheduled_date ASC`,
      [technician_id]
    );

    const rides = result.rows.map((row) => ({
      ...row,
      distance:        toNum(row.distance),
      duration:        toNum(row.duration),
      price:           toNum(row.customer_total || row.price),
      customer_total:  toNum(row.customer_total || row.price),
      pickup_lat:      toNum(row.pickup_lat),
      pickup_lng:      toNum(row.pickup_lng),
      drop_lat:        toNum(row.drop_lat),
      drop_lng:        toNum(row.drop_lng),
      payment_method:  row.payment_method || "cash",
      car_details: row.car_details
        ? typeof row.car_details === "string" ? JSON.parse(row.car_details) : row.car_details
        : null,
      time_until_ride: row.scheduled_date
        ? Math.max(0, Math.round((new Date(row.scheduled_date) - new Date()) / (1000 * 60)))
        : null,
    }));

    res.json(rides);
  } catch (err) {
    console.error("UPCOMING RIDES ERROR:", err);
    res.status(500).json({ error: "Failed to fetch upcoming rides" });
  }
});

// ================================================================
// ==================== UPCOMING RIDES FOR USER ===================
// ================================================================

router.get("/upcoming/by-user", async (req, res) => {
  const { firebase_uid } = req.query;
  if (!firebase_uid)
    return res.status(400).json({ error: "firebase_uid required" });

  try {
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid=$1",
      [firebase_uid]
    );
    if (!userRes.rows.length) return res.json([]);
    const userId = userRes.rows[0].id;

    const result = await pool.query(
      `SELECT
        o.id, o.service_type, o.status, o.distance, o.duration,
        o.price, o.customer_total, o.payment_method,
        o.pickup_address AS pickup, o.drop_address AS drop,
        o.vehicle, o.car_details, o.otp,
        o.is_scheduled, o.scheduled_date,
        o.accepted_at, o.created_at,
        t.full_name AS driver_name,
        t.phone     AS driver_phone,
        t.vehicle   AS driver_vehicle
       FROM orders o
       LEFT JOIN order_technicians ot ON ot.order_id = o.id
       LEFT JOIN technicians t ON t.id = ot.technician_id
       WHERE o.user_id = $1
         AND o.is_scheduled = true
         AND o.status IN ('created','requested','accepted')
         AND o.scheduled_date > NOW()
       ORDER BY o.scheduled_date ASC`,
      [userId]
    );

    const rides = result.rows.map((row) => ({
      ...row,
      price:          toNum(row.customer_total || row.price),
      customer_total: toNum(row.customer_total || row.price),
      car_details: row.car_details
        ? typeof row.car_details === "string" ? JSON.parse(row.car_details) : row.car_details
        : null,
      driver_assigned: !!row.driver_name,
      time_until_ride: row.scheduled_date
        ? Math.max(0, Math.round((new Date(row.scheduled_date) - new Date()) / (1000 * 60)))
        : null,
      status_label: {
        created:   "Waiting for driver",
        requested: "Finding driver...",
        accepted:  "Driver confirmed ✅",
      }[row.status] || row.status,
    }));

    res.json(rides);
  } catch (err) {
    console.error("USER UPCOMING RIDES ERROR:", err);
    res.status(500).json({ error: "Failed to fetch upcoming rides" });
  }
});

// ================================================================
// ==================== RIDE HISTORY FOR USER =====================
// ================================================================

router.get("/history", async (req, res) => {
  const { firebase_uid } = req.query;
  if (!firebase_uid)
    return res.status(400).json({ error: "firebase_uid required" });

  try {
    const userRes = await pool.query(
      "SELECT id, name FROM users WHERE firebase_uid = $1",
      [firebase_uid]
    );
    if (!userRes.rows.length) return res.json([]);
    const userId = userRes.rows[0].id;

    const result = await pool.query(
      `SELECT
        o.id, o.service_type, o.status,
        o.distance, o.duration, o.price, o.customer_total,
        o.payment_method, o.payment_mode,
        o.pickup_address AS pickup, o.drop_address AS drop,
        o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng,
        o.vehicle, o.package_name, o.car_details, o.otp, o.rating,
        o.is_scheduled, o.scheduled_date, o.cancellation_reason,
        o.driver_earning, o.platform_commission,
        o.total_platform_earning, o.gst_on_commission,
        o.created_at, o.accepted_at, o.completed_at, o.cancelled_at,
        t.full_name AS driver_name,
        t.phone     AS driver_phone,
        t.vehicle   AS driver_vehicle,
        t.rating    AS driver_rating
       FROM orders o
       LEFT JOIN order_technicians ot ON ot.order_id = o.id
       LEFT JOIN technicians t ON t.id = ot.technician_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [userId]
    );

    const orders = result.rows.map((row) => ({
      ...row,
      price:          toNum(row.customer_total || row.price),
      customer_total: toNum(row.customer_total || row.price),
      distance:       toNum(row.distance),
      duration:       toNum(row.duration),
      pickup_lat:     toNum(row.pickup_lat),
      pickup_lng:     toNum(row.pickup_lng),
      drop_lat:       toNum(row.drop_lat),
      drop_lng:       toNum(row.drop_lng),
      payment_method: row.payment_method || row.payment_mode || "cash",
      car_details: row.car_details
        ? typeof row.car_details === "string" ? JSON.parse(row.car_details) : row.car_details
        : null,
      is_scheduled:    row.is_scheduled || false,
      driver_assigned: !!row.driver_name,
    }));

    res.json(orders);
  } catch (err) {
    console.error("HISTORY ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ================================================================
// ==================== SEND REQUEST (WAVE DISPATCH) ==============
// ================================================================

router.post("/:id/request", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid order id" });

  try {
    const result = await pool.query(
      `UPDATE orders SET status='requested', updated_at=NOW()
       WHERE id=$1 AND status='created'
       RETURNING id, service_type, price, customer_total,
                 pickup_address, drop_address, payment_method,
                 is_scheduled, scheduled_date,
                 pickup_lat, pickup_lng`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error:   "Order not found or already requested",
        orderId: id,
      });
    }

    const order      = result.rows[0];
    const pickupLat  = toNum(order.pickup_lat);
    const pickupLng  = toNum(order.pickup_lng);

    console.log(`\n🚀 ORDER ${id} REQUEST | ${order.service_type}`);

    if (pickupLat && pickupLng) {
      // ✅ Wave dispatch — non-blocking background job
      setImmediate(() => {
        runWaveDispatch(id, pickupLat, pickupLng, order.service_type)
          .catch((err) => console.error(`Wave dispatch error for order ${id}:`, err.message));
      });

      return res.json({
        success:      true,
        message:      "Driver search started with wave dispatch",
        orderId:      id,
        serviceType:  order.service_type,
        dispatch:     "wave_algorithm",
        waves:        DISPATCH_WAVES.map((w) => ({
          radius:      `${w.radiusKm}km`,
          maxDrivers:  w.maxDrivers,
          waitSeconds: w.waitSeconds,
        })),
      });
    }

    // ✅ Fallback — broadcast when no pickup coords
    console.warn(`⚠️  Order ${id} has no pickup coords — broadcast fallback`);
    const categoryVariants = getCategoryVariants(order.service_type);

    const allTechsRes = await pool.query(
      `SELECT id, full_name, category, is_available,
              push_token IS NOT NULL AS has_token
       FROM technicians WHERE category=ANY($1::text[])`,
      [categoryVariants]
    );

    const techRes = await pool.query(
      `SELECT id, push_token, full_name, category
       FROM technicians
       WHERE category=ANY($1::text[])
         AND is_available=true
         AND push_token IS NOT NULL`,
      [categoryVariants]
    );

    let sentCount = 0;
    for (const tech of techRes.rows) {
      try {
        await sendRideRequestPush(tech.push_token, {
          ...order,
          price:        toNum(order.customer_total || order.price),
          is_scheduled: order.is_scheduled || false,
        });
        sentCount++;
        console.log(`   ✅ Push sent to ${tech.full_name}`);
      } catch (pushErr) {
        console.error(`   ❌ Push failed for ${tech.full_name}:`, pushErr.message);
      }
    }

    res.json({
      success:              true,
      message:              `Broadcast: ${sentCount} drivers notified`,
      orderId:              id,
      dispatch:             "broadcast_fallback",
      technicians_notified: sentCount,
      debug: {
        service_type:               order.service_type,
        category_searched:          categoryVariants,
        total_matching_technicians: allTechsRes.rows.length,
        available_with_token:       techRes.rows.length,
        pushes_sent:                sentCount,
        technicians:                allTechsRes.rows,
      },
    });
  } catch (err) {
    console.error("REQUEST ERROR:", err);
    res.status(500).json({ error: "Failed to send request", details: err.message });
  }
});

// ================================================================
// ==================== PENDING ORDERS (SMART FILTER) =============
// ================================================================

router.get("/pending/list", async (req, res) => {
  const { category, technician_id, lat, lng } = req.query;

  if (!technician_id || !category)
    return res.status(400).json({ error: "category and technician_id required" });

  const categoryVariants = getCategoryVariants(category);
  const techLat          = toNum(lat);
  const techLng          = toNum(lng);

  try {
    const activeRide = await pool.query(
      `SELECT o.id, o.status FROM orders o
       JOIN order_technicians ot ON ot.order_id = o.id
       WHERE ot.technician_id = $1
         AND o.status IN ('accepted','arrived','in_progress')
         AND (o.is_scheduled = false OR o.is_scheduled IS NULL)
       LIMIT 1`,
      [technician_id]
    );

    if (activeRide.rows.length > 0) {
      console.log(`Tech ${technician_id} has active ride → returning empty`);
      return res.json([]);
    }

    const techCheck = await pool.query(
      `SELECT id, is_available, category FROM technicians WHERE id=$1`,
      [technician_id]
    );
    if (!techCheck.rows.length)
      return res.status(404).json({ error: "Technician not found" });

    const tech = techCheck.rows[0];
    console.log(`\n📋 PENDING LIST | Tech ${technician_id} | available: ${tech.is_available}`);

    if (!tech.is_available) {
      const hasScheduledOnly = await pool.query(
        `SELECT COUNT(*) AS cnt FROM orders o
         JOIN order_technicians ot ON ot.order_id = o.id
         WHERE ot.technician_id = $1 AND o.status='accepted' AND o.is_scheduled=true`,
        [technician_id]
      );
      const scheduledCount = parseInt(hasScheduledOnly.rows[0].cnt);
      if (scheduledCount === 0) {
        console.log(`   → Tech not available`);
        return res.json([]);
      }
      await pool.query(
        `UPDATE technicians SET is_available=true WHERE id=$1`,
        [technician_id]
      );
    }

    const result = await pool.query(
      `SELECT
        o.id, o.distance, o.duration, o.price, o.customer_total,
        o.payment_method, o.payment_mode, o.pickup_address, o.drop_address,
        o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng,
        o.vehicle, o.package_name, o.car_details, o.created_at,
        o.scheduled_date, o.is_scheduled, o.service_type,
        u.name AS client_name, u.phone AS client_phone
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.status='requested'
         AND o.service_type=ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM order_rejections r
           WHERE r.order_id=o.id AND r.technician_id=$2
         )
         AND NOT EXISTS (
           SELECT 1 FROM order_technicians ot2
           WHERE ot2.order_id=o.id
         )
       ORDER BY o.is_scheduled ASC, o.created_at DESC`,
      [categoryVariants, technician_id]
    );

    console.log(`   → Found ${result.rows.length} pending orders`);

    let orders = result.rows.map((row) => {
      const base = {
        ...row,
        distance:       toNum(row.distance),
        duration:       toNum(row.duration),
        price:          toNum(row.customer_total || row.price),
        customer_total: toNum(row.customer_total || row.price),
        pickup_lat:     toNum(row.pickup_lat),
        pickup_lng:     toNum(row.pickup_lng),
        drop_lat:       toNum(row.drop_lat),
        drop_lng:       toNum(row.drop_lng),
        payment_method: row.payment_method || row.payment_mode || "cash",
        is_scheduled:   row.is_scheduled || false,
        car_details: row.car_details
          ? typeof row.car_details === "string" ? JSON.parse(row.car_details) : row.car_details
          : null,
      };

      // Add distance_to_pickup if tech location provided
      if (techLat && techLng && base.pickup_lat && base.pickup_lng) {
        base.distance_to_pickup = Math.round(
          haversineDistance(techLat, techLng, base.pickup_lat, base.pickup_lng) * 10
        ) / 10;
        base.eta_minutes = Math.round(base.distance_to_pickup * 3);
      }

      return base;
    });

    // Sort by distance_to_pickup if tech location available
    if (techLat && techLng) {
      orders.sort((a, b) => (a.distance_to_pickup || 999) - (b.distance_to_pickup || 999));
    }

    res.json(orders);
  } catch (err) {
    console.error("PENDING LIST ERROR:", err);
    res.status(500).json({ error: "Failed to fetch orders", details: err.message });
  }
});

// ================================================================
// ==================== ACCEPT ORDER (MUTEX LOCK) =================
// ================================================================

router.post("/:id/accept", async (req, res) => {
  const { technician_id } = req.body;
  const id = Number(req.params.id);

  if (isNaN(id))      return res.status(400).json({ error: "Invalid order id" });
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  // LAYER 1: In-memory mutex
  if (!acquireOrderLock(id)) {
    return res.status(409).json({
      error:   "ORDER_LOCKED",
      message: "Order is currently being processed. Try again in 2 seconds.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // LAYER 2: Check active ride
    const activeNonScheduled = await client.query(
      `SELECT o.id, o.status, o.service_type FROM orders o
       JOIN order_technicians ot ON ot.order_id = o.id
       WHERE ot.technician_id = $1
         AND o.status IN ('accepted','arrived','in_progress')
         AND (o.is_scheduled = false OR o.is_scheduled IS NULL)
       LIMIT 1`,
      [technician_id]
    );

    // LAYER 3: PostgreSQL row-level lock
    const orderRes = await client.query(
      `SELECT
        o.id, o.status, o.service_type, o.price, o.customer_total,
        o.payment_method, o.is_scheduled, o.scheduled_date,
        o.pickup_address, o.drop_address,
        u.push_token AS user_push_token,
        u.name       AS user_name,
        u.id         AS user_id
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.id = $1 FOR UPDATE NOWAIT`,
      [id]
    );

    if (!orderRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderRes.rows[0];

    if (!order.is_scheduled && activeNonScheduled.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:     "ACTIVE_RIDE_EXISTS",
        message:   "Complete your current ride before accepting a new one",
        activeRide: activeNonScheduled.rows[0],
      });
    }

    // LAYER 4: Final status check
    if (order.status !== "requested") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error:         "ORDER_ALREADY_TAKEN",
        message:       "This order was already accepted by another driver",
        currentStatus: order.status,
      });
    }

    const techRes = await client.query(
      `SELECT id, full_name, phone FROM technicians WHERE id=$1`,
      [technician_id]
    );
    const tech = techRes.rows[0];
    const otp  = Math.floor(1000 + Math.random() * 9000);

    await client.query(
      `INSERT INTO order_technicians (order_id, technician_id) VALUES ($1,$2)`,
      [id, technician_id]
    );

    await client.query(
      `UPDATE orders
       SET status='accepted', otp=$2, accepted_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [id, otp]
    );

    if (!order.is_scheduled) {
      await client.query(
        `UPDATE technicians
         SET is_available=false, current_order_id=$2, updated_at=NOW()
         WHERE id=$1`,
        [technician_id, id]
      );
    }

    await client.query("COMMIT");

    console.log(`\n✅ Order ${id} accepted by tech ${technician_id} | OTP: ${otp}`);

    if (order.user_push_token) {
      sendRideConfirmedPush(order.user_push_token, {
        orderId:       id,
        driverName:    tech?.full_name || "Your Driver",
        driverPhone:   tech?.phone     || "",
        isScheduled:   order.is_scheduled,
        scheduledDate: order.scheduled_date,
        otp,
      }).then(() => {
        console.log(`📱 Customer notified: ${order.user_name}`);
      }).catch((e) => {
        console.error(`⚠️  Customer push failed:`, e.message);
      });
    }

    res.json({
      success:       true,
      otp,
      orderId:       id,
      serviceType:   order.service_type,
      isScheduled:   order.is_scheduled,
      scheduledDate: order.scheduled_date || null,
      price:         toNum(order.customer_total || order.price),
      paymentMethod: order.payment_method || "cash",
      pickupAddress: order.pickup_address,
      dropAddress:   order.drop_address,
      nextScreen:    order.is_scheduled ? "Upcoming" : "ActiveRideScreen",
      message:       order.is_scheduled
        ? `Scheduled ride accepted! Starts on ${new Date(order.scheduled_date).toLocaleString("en-IN", {
            weekday: "short", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
          })}`
        : "Order accepted successfully",
    });

  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "55P03") {
      return res.status(409).json({
        error:   "ORDER_LOCKED",
        message: "Another driver is accepting this order. Try again in 2 seconds.",
      });
    }
    console.error("ACCEPT ERROR:", err);
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(id);
    client.release();
  }
});

// ================================================================
// ==================== REJECT ORDER ==============================
// ================================================================

router.post("/:id/reject", async (req, res) => {
  const { technician_id } = req.body;
  const id = Number(req.params.id);
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });
  try {
    await pool.query(
      `INSERT INTO order_rejections (order_id, technician_id)
       VALUES ($1,$2) ON CONFLICT (order_id, technician_id) DO NOTHING`,
      [id, technician_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("REJECT ERROR:", err);
    res.status(500).json({ error: "Failed to reject order" });
  }
});

// ================================================================
// ==================== ACCEPTED LIST =============================
// ================================================================

router.get("/accepted/list", async (req, res) => {
  const { technician_id } = req.query;
  if (!technician_id)
    return res.status(400).json({ error: "technician_id required" });

  try {
    const result = await pool.query(
      `SELECT
        o.id, o.service_type, o.distance, o.duration, o.price,
        o.customer_total, o.payment_method, o.status, o.vehicle,
        o.package_name, o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng,
        o.pickup_address, o.drop_address, o.otp, o.car_details,
        o.pre_photos, o.post_photos, o.wash_started_at, o.created_at,
        o.is_scheduled, o.scheduled_date,
        u.name  AS client_name,
        u.phone AS client_phone
       FROM orders o
       JOIN order_technicians ot ON ot.order_id = o.id
       JOIN users u ON u.id = o.user_id
       WHERE o.status IN ('accepted','arrived','in_progress')
         AND ot.technician_id = $1
       ORDER BY o.is_scheduled ASC, o.created_at DESC`,
      [technician_id]
    );

    const orders = result.rows.map((row) => ({
      ...row,
      distance:       toNum(row.distance),
      duration:       toNum(row.duration),
      price:          toNum(row.customer_total || row.price),
      customer_total: toNum(row.customer_total || row.price),
      pickup_lat:     toNum(row.pickup_lat),
      pickup_lng:     toNum(row.pickup_lng),
      drop_lat:       toNum(row.drop_lat),
      drop_lng:       toNum(row.drop_lng),
      payment_method: row.payment_method || "cash",
      car_details: row.car_details
        ? typeof row.car_details === "string" ? JSON.parse(row.car_details) : row.car_details
        : null,
    }));

    res.json(orders);
  } catch (err) {
    console.error("ACCEPTED LIST ERROR:", err);
    res.status(500).json({ error: "Failed to fetch accepted orders" });
  }
});

// ================================================================
// ==================== USER TRIPS (LEGACY) =======================
// ================================================================

router.get("/user/:firebase_uid", async (req, res) => {
  const { firebase_uid } = req.params;
  try {
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid=$1",
      [firebase_uid]
    );
    if (!userRes.rows.length) return res.json([]);
    const userId = userRes.rows[0].id;

    const result = await pool.query(
      `SELECT
        o.id, o.service_type, o.status, o.distance, o.duration,
        o.price, o.customer_total, o.payment_method,
        o.pickup_address AS pickup, o.drop_address AS drop,
        o.vehicle, o.package_name, o.rating,
        o.is_scheduled, o.scheduled_date,
        o.created_at, o.completed_at
       FROM orders o
       WHERE o.user_id=$1
       ORDER BY o.created_at DESC LIMIT 30`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("USER TRIPS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch trips" });
  }
});

// ================================================================
// ==================== ACTIVE ORDER BY USER ======================
// ================================================================

router.get("/active/by-user", async (req, res) => {
  const { firebase_uid } = req.query;
  if (!firebase_uid)
    return res.status(400).json({ error: "firebase_uid required" });

  try {
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid=$1",
      [firebase_uid]
    );
    if (!userRes.rows.length) return res.json(null);
    const userId = userRes.rows[0].id;

    const orderRes = await pool.query(
      `SELECT
        id, status, service_type, created_at,
        advance_amount, price,
        COALESCE(remaining_amount, price - COALESCE(advance_amount, 0)) AS remaining_amount
       FROM orders
       WHERE user_id=$1
         AND status IN ('requested','accepted','arrived','in_progress')
         AND (is_scheduled=false OR is_scheduled IS NULL)
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (!orderRes.rows.length) return res.json(null);

    const row = orderRes.rows[0];
    const cleanOrder = {
      id:               Number(row.id)             || 0,
      status:           String(row.status          || ""),
      service_type:     String(row.service_type    || ""),
      created_at:       String(row.created_at      || ""),
      advance_amount:   Number(row.advance_amount) || 0,
      price:            Number(row.price)          || 0,
      remaining_amount: Number(row.remaining_amount) || 0,
    };

    res.json(cleanOrder);
  } catch (err) {
    console.error("ACTIVE ORDER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================================================================
// ==================== GET ORDER DETAILS =========================
// ================================================================

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid order id" });

  try {
    const orderRes = await pool.query(
      `SELECT o.*, u.name AS client_name, u.phone AS client_phone
       FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.id=$1`,
      [id]
    );
    if (!orderRes.rows.length)
      return res.status(404).json({ error: "Order not found" });

    const order = orderRes.rows[0];
    let driver = null, driverLocation = null;

    if (["accepted","arrived","in_progress"].includes(order.status)) {
      const techRes = await pool.query(
        `SELECT t.id, t.full_name, t.phone, t.vehicle, t.experience, t.rating
         FROM order_technicians ot
         JOIN technicians t ON t.id = ot.technician_id
         WHERE ot.order_id=$1`,
        [id]
      );
      if (techRes.rows.length) driver = techRes.rows[0];

      const locRes = await pool.query(
        `SELECT lat, lng, updated_at FROM driver_locations
         WHERE order_id=$1 ORDER BY updated_at DESC LIMIT 1`,
        [id]
      );
      if (locRes.rows.length) {
        driverLocation = {
          lat:        toNum(locRes.rows[0].lat),
          lng:        toNum(locRes.rows[0].lng),
          updated_at: locRes.rows[0].updated_at,
        };
      }
    }

    const formatDuration = (min) => {
      if (!min) return null;
      if (min < 60) return `${min} mins`;
      const h = Math.floor(min / 60), m = min % 60;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };

    const carDetails = order.car_details
      ? typeof order.car_details === "string" ? JSON.parse(order.car_details) : order.car_details
      : null;

    res.json({
      ...order,
      car_details:    carDetails,
      pickup_lat:     toNum(order.pickup_lat),
      pickup_lng:     toNum(order.pickup_lng),
      drop_lat:       toNum(order.drop_lat),
      drop_lng:       toNum(order.drop_lng),
      distance:       toNum(order.distance),
      duration:       toNum(order.duration),
      price:          toNum(order.customer_total || order.price),
      customer_total: toNum(order.customer_total || order.price),
      distance_text:  order.distance ? `${order.distance} km` : null,
      duration_text:  formatDuration(toNum(order.duration)),
      distance_km:    toNum(order.distance),
      duration_min:   toNum(order.duration),
      driver,
      driver_name:    driver?.full_name || null,
      driver_phone:   driver?.phone     || null,
      vehicle_number: driver?.vehicle   || null,
      vehicle_model:  order.vehicle     || "Vehicle",
      driverLocation,
      pickupLocation: toNum(order.pickup_lat) && toNum(order.pickup_lng)
        ? { lat: toNum(order.pickup_lat), lng: toNum(order.pickup_lng) }
        : null,
      dropLocation: toNum(order.drop_lat) && toNum(order.drop_lng)
        ? { lat: toNum(order.drop_lat), lng: toNum(order.drop_lng) }
        : null,
      paymentBreakdown: {
        paymentMethod:        order.payment_method || order.payment_mode || "cash",
        customerTotal:        toNum(order.customer_total) || toNum(order.price),
        driverEarning:        toNum(order.driver_earning) || toNum(order.technician_earnings),
        platformCommission:   toNum(order.platform_commission),
        platformFixedFee:     toNum(order.platform_fixed_fee),
        totalPlatformEarning: toNum(order.total_platform_earning),
        gstOnCommission:      toNum(order.gst_on_commission),
        settlementStatus:     order.settlement_status,
      },
    });
  } catch (err) {
    console.error("GET ORDER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================================================================
// ==================== UPDATE DRIVER LOCATION (ON-TRIP) ==========
// ================================================================

router.post("/:id/location", async (req, res) => {
  const orderId = Number(req.params.id);
  const { technician_id, lat, lng } = req.body;
  const numLat = toNum(lat);
  const numLng = toNum(lng);

  if (!numLat || !numLng || !technician_id)
    return res.status(400).json({ error: "Missing or invalid coordinates" });

  try {
    const geohash = ngeohash.encode(numLat, numLng, 6);

    // Update order-specific location
    await pool.query(
      `INSERT INTO driver_locations (order_id, technician_id, lat, lng, geohash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (order_id)
       DO UPDATE SET lat=$3, lng=$4, geohash=$5, updated_at=NOW()`,
      [orderId, technician_id, numLat, numLng, geohash]
    );

    res.json({ success: true, geohash });
  } catch (err) {
    console.error("LOCATION ERROR:", err);
    res.status(500).json({ error: "Failed to update location" });
  }
});

// ================================================================
// ==================== TECHNICIAN AVAILABILITY LOCATION ==========
// ================================================================
// TechApp calls this every 8-10 seconds when available (not on ride)
// This powers the geohash discovery in findNearbyDrivers()
// ================================================================

router.post("/technician-location", async (req, res) => {
  const { technician_id, lat, lng } = req.body;
  const numLat = toNum(lat);
  const numLng = toNum(lng);

  if (!numLat || !numLng || !technician_id)
    return res.status(400).json({ error: "technician_id, lat, lng required" });

  try {
    const geohash = ngeohash.encode(numLat, numLng, 6);

    // Upsert availability beacon with order_id=0
    await pool.query(
      `INSERT INTO driver_locations (order_id, technician_id, lat, lng, geohash)
       VALUES (0, $1, $2, $3, $4)
       ON CONFLICT (order_id, technician_id)
       DO UPDATE SET lat=$2, lng=$3, geohash=$4, updated_at=NOW()`,
      [technician_id, numLat, numLng, geohash]
    );

    res.json({ success: true, geohash });
  } catch (err) {
    // Fallback update
    try {
      const geohash = ngeohash.encode(numLat, numLng, 6);
      await pool.query(
        `UPDATE driver_locations
         SET lat=$2, lng=$3, geohash=$4, updated_at=NOW()
         WHERE technician_id=$1 AND order_id=0`,
        [technician_id, numLat, numLng, geohash]
      );
      res.json({ success: true });
    } catch (e2) {
      console.error("TECHNICIAN LOCATION ERROR:", e2);
      res.status(500).json({ error: "Failed to update location" });
    }
  }
});

// ================================================================
// ==================== DRIVER ARRIVED ============================
// ================================================================

router.post("/:id/arrived", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query(
      `UPDATE orders SET status='arrived', arrived_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='accepted'`,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("ARRIVED ERROR:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// ================================================================
// ==================== VERIFY OTP ================================
// ================================================================

router.post("/:id/verify-otp", async (req, res) => {
  const id = Number(req.params.id);
  const { otp } = req.body;
  try {
    const result = await pool.query("SELECT otp FROM orders WHERE id=$1", [id]);
    if (!result.rows.length)
      return res.status(404).json({ error: "Order not found" });
    if (Number(result.rows[0].otp) !== Number(otp))
      return res.status(400).json({ error: "Invalid OTP" });
    await pool.query(
      `UPDATE orders SET status='in_progress', started_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("VERIFY OTP ERROR:", err);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// ================================================================
// ==================== COMPLETE ORDER ============================
// ================================================================

router.post("/:id/complete", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const orderRes = await pool.query(
      `SELECT o.*, ot.technician_id
       FROM orders o
       LEFT JOIN order_technicians ot ON ot.order_id = o.id
       WHERE o.id=$1`,
      [id]
    );
    if (!orderRes.rows.length)
      return res.status(404).json({ error: "Order not found" });

    const order         = orderRes.rows[0];
    const paymentMethod = order.payment_method || order.payment_mode || "cash";
    const serviceType   = order.service_type;

    if (!["in_progress","arrived","accepted"].includes(order.status)) {
      return res.status(400).json({
        error:   "INVALID_STATUS",
        message: `Cannot complete order with status: ${order.status}`,
      });
    }

    if (serviceType === "car_wash" && paymentMethod !== "cash" && order.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not completed for this wash" });
    }

    await pool.query(
      `UPDATE orders SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [id]
    );

    if (order.technician_id) {
      await pool.query(
        `UPDATE technicians
         SET is_available=true, current_order_id=NULL, updated_at=NOW()
         WHERE id=$1`,
        [order.technician_id]
      );
    }

    console.log(`✅ Order ${id} completed`);

    let earnings = null, earningsError = null;
    try {
      const calculateEarnings = await getCalculateEarnings();
      earnings = await calculateEarnings(id);
      console.log(`✅ Earnings — Driver: ₹${earnings.driverEarning} | Platform: ₹${earnings.totalPlatformEarning}`);
    } catch (earnErr) {
      earningsError = earnErr.message;
      console.error(`⚠️  Earnings failed for Order ${id}:`, earnErr.message);
    }

    const customerTotal = parseFloat(order.customer_total || order.price || 0);

    res.json({
      success:            true,
      orderId:            id,
      earnings: earnings
        ? {
            driverEarning:   earnings.driverEarning,
            platformEarning: earnings.totalPlatformEarning,
            paymentMethod:   earnings.paymentMethod,
            customerTotal:   earnings.customerTotal,
          }
        : {
            driverEarning:   customerTotal,
            platformEarning: 0,
            paymentMethod,
            customerTotal,
          },
      earningsCalculated: !!earnings,
      earningsError,
      paymentMethod,
    });
  } catch (err) {
    console.error("COMPLETE ORDER ERROR:", err);
    res.status(500).json({ error: "Failed to complete order", details: err.message });
  }
});

// ================================================================
// ==================== CANCEL ORDER ==============================
// ================================================================

router.post("/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  const { reason = "User cancelled", technician_id = null } = req.body;
  try {
    await pool.query(
      `UPDATE orders
       SET status='cancelled', cancellation_reason=$2,
           cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status IN ('created','requested')`,
      [id, reason]
    );
    if (technician_id) {
      await pool.query(
        `UPDATE technicians SET is_available=true, current_order_id=NULL WHERE id=$1`,
        [technician_id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("CANCEL ERROR:", err);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

// ================================================================
// ==================== CAR WASH ROUTES ===========================
// ================================================================

router.post("/:id/pre-photos", async (req, res) => {
  const id = Number(req.params.id);
  const { photos } = req.body;
  if (!photos || !Array.isArray(photos))
    return res.status(400).json({ error: "Photos array required" });
  try {
    await pool.query(
      `UPDATE orders SET pre_photos=$1::jsonb, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(photos), id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save photos" });
  }
});

router.post("/:id/start-wash", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE orders SET status='in_progress', wash_started_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING wash_started_at`,
      [id]
    );
    res.json({ success: true, wash_started_at: result.rows[0]?.wash_started_at });
  } catch (err) {
    res.status(500).json({ error: "Failed to start wash" });
  }
});

router.post("/:id/post-photos", async (req, res) => {
  const id = Number(req.params.id);
  const { photos } = req.body;
  if (!photos || !Array.isArray(photos))
    return res.status(400).json({ error: "Photos array required" });
  try {
    await pool.query(
      `UPDATE orders SET post_photos=$1::jsonb, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(photos), id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save photos" });
  }
});

// ================================================================
// ==================== COMPLETE WASH (FIXED) =====================
// ================================================================
// Car wash payment is online (pre-paid) → always settled, no dues
// ================================================================

router.post("/:id/complete-wash", async (req, res) => {
  const id = Number(req.params.id);
  try {
    // ✅ Mark as completed with online settlement
    await pool.query(
      `UPDATE orders
       SET status            = 'completed',
           wash_completed_at = NOW(),
           completed_at      = NOW(),
           -- ✅ Force online payment method for car wash
           payment_method    = COALESCE(
             CASE WHEN payment_method IN ('online','upi','card','razorpay')
               THEN payment_method
               ELSE 'online'
             END,
             'online'
           ),
           settlement_status = 'settled',
           updated_at        = NOW()
       WHERE id = $1`,
      [id]
    );

    // ✅ Calculate earnings — will auto-detect car_wash → online flow
    try {
      const calculateEarnings = await getCalculateEarnings();
      const result = await calculateEarnings(id);
      console.log(`🚿 Car wash earnings: Driver ₹${result.driverEarning} credited directly to wallet`);
    } catch (e) {
      console.error("Wash earnings calc failed:", e.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("COMPLETE WASH ERROR:", err);
    res.status(500).json({ error: "Failed to complete wash" });
  }
});

// ================================================================
// ==================== PAYMENT ROUTES ============================
// ================================================================

router.post("/:id/create-payment", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const orderRes = await pool.query(
      "SELECT price, customer_total FROM orders WHERE id=$1", [id]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: "Not found" });
    const price    = toNum(orderRes.rows[0].customer_total || orderRes.rows[0].price);
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(price * 100), currency: "INR",
      receipt: `receipt_order_${id}`,
    });
    res.json({
      orderId: rzpOrder.id, amount: rzpOrder.amount,
      currency: rzpOrder.currency, key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment creation failed" });
  }
});

router.post("/:id/verify-payment", async (req, res) => {
  const id = Number(req.params.id);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  try {
    const body     = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body).digest("hex");
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: "Invalid signature" });
    await pool.query(
      `UPDATE orders SET payment_status='paid', payment_id=$2, updated_at=NOW() WHERE id=$1`,
      [id, razorpay_payment_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Payment verification failed" });
  }
});

router.get("/:id/payment-status", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT price, customer_total, advance_amount, remaining_amount,
              advance_payment_status, final_payment_status, payment_status,
              advance_paid_at, final_paid_at, payment_method
       FROM orders WHERE id=$1`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    const o         = result.rows[0];
    const total     = toNum(o.customer_total || o.price);
    const advance   = toNum(o.advance_amount) || Math.round(total * 0.3333);
    const remaining = toNum(o.remaining_amount) || total - advance;
    res.json({
      totalAmount:     total,
      advanceAmount:   advance,
      remainingAmount: remaining,
      advanceStatus:   o.advance_payment_status || "pending",
      finalStatus:     o.final_payment_status   || "pending",
      overallStatus:   o.payment_status         || "pending",
      paymentMethod:   o.payment_method         || "cash",
      advancePaidAt:   o.advance_paid_at,
      finalPaidAt:     o.final_paid_at,
      isFullyPaid:     o.payment_status === "paid",
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payment status" });
  }
});

router.post("/:id/create-advance-payment", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const orderRes = await pool.query(
      "SELECT price, customer_total, advance_amount FROM orders WHERE id=$1", [id]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: "Not found" });
    const order         = orderRes.rows[0];
    const totalPrice    = toNum(order.customer_total || order.price);
    const advanceAmount = toNum(order.advance_amount) || Math.round(totalPrice * 0.3333);
    const rzpOrder      = await razorpay.orders.create({
      amount: advanceAmount * 100, currency: "INR",
      receipt: `advance_${id}_${Date.now()}`,
      notes: { order_id: id.toString(), payment_type: "advance" },
    });
    await pool.query(
      `UPDATE orders SET advance_razorpay_order_id=$1, advance_amount=$2 WHERE id=$3`,
      [rzpOrder.id, advanceAmount, id]
    );
    res.json({
      orderId: rzpOrder.id, amount: rzpOrder.amount,
      currency: rzpOrder.currency, key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    res.status(500).json({ error: "Payment creation failed" });
  }
});

router.post("/:id/verify-advance-payment", async (req, res) => {
  const id = Number(req.params.id);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  try {
    const body     = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body).digest("hex");
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: "Invalid signature" });
    await pool.query(
      `UPDATE orders
       SET advance_payment_status='paid', advance_payment_id=$2,
           advance_paid_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [id, razorpay_payment_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

router.post("/:id/create-final-payment", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const orderRes = await pool.query(
      `SELECT price, customer_total, advance_amount, remaining_amount,
              advance_payment_status, final_payment_status FROM orders WHERE id=$1`,
      [id]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: "Not found" });
    const order = orderRes.rows[0];
    if (order.advance_payment_status !== "paid")
      return res.status(400).json({ error: "Advance payment not completed" });
    if (order.final_payment_status === "paid")
      return res.status(400).json({ error: "Final payment already completed" });
    const totalPrice  = toNum(order.customer_total || order.price);
    const advancePaid = toNum(order.advance_amount) || Math.round(totalPrice * 0.3333);
    const remaining   = toNum(order.remaining_amount) || totalPrice - advancePaid;
    const rzpOrder    = await razorpay.orders.create({
      amount: Math.round(remaining * 100), currency: "INR",
      receipt: `final_${id}_${Date.now()}`,
      notes: { order_id: id.toString(), payment_type: "final" },
    });
    await pool.query(
      `UPDATE orders
       SET final_razorpay_order_id=$1, remaining_amount=$2,
           final_payment_status='pending', updated_at=NOW()
       WHERE id=$3`,
      [rzpOrder.id, remaining, id]
    );
    res.json({
      orderId: rzpOrder.id, amount: rzpOrder.amount,
      currency: rzpOrder.currency, key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    res.status(500).json({ error: "Payment creation failed" });
  }
});

// ================================================================
// ==================== VERIFY FINAL PAYMENT (FIXED) ==============
// ================================================================

router.post("/:id/verify-final-payment", async (req, res) => {
  const id = Number(req.params.id);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  try {
    const body     = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body).digest("hex");

    if (expected !== razorpay_signature)
      return res.status(400).json({ error: "Invalid signature" });

    // ✅ Mark payment as online/paid
    await pool.query(
      `UPDATE orders
       SET final_payment_status = 'paid',
           final_payment_id     = $2,
           final_paid_at        = NOW(),
           payment_status       = 'paid',
           payment_method       = 'online',
           settlement_status    = 'settled',
           status               = 'completed',
           completed_at         = NOW(),
           updated_at           = NOW()
       WHERE id = $1`,
      [id, razorpay_payment_id]
    );

    // ✅ Calculate earnings with online payment method
    try {
      const calculateEarnings = await getCalculateEarnings();
      const result = await calculateEarnings(id);
      console.log(`💳 Online payment earnings: Driver ₹${result.driverEarning} → wallet`);
    } catch (e) {
      console.error("Earnings after final payment failed:", e.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("VERIFY FINAL PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

router.post("/:id/mark-advance-paid", async (req, res) => {
  const id = Number(req.params.id);
  const { payment_method, payment_id } = req.body;
  try {
    await pool.query(
      `UPDATE orders
       SET advance_payment_status='paid', advance_payment_id=$2,
           advance_paid_at=NOW(), payment_mode=$3, updated_at=NOW()
       WHERE id=$1`,
      [id, payment_id || `ADV_${Date.now()}`, payment_method || "upi"]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark advance paid" });
  }
});

router.post("/:id/mark-final-paid", async (req, res) => {
  const id = Number(req.params.id);
  const { payment_id } = req.body;
  try {
    await pool.query(
      `UPDATE orders
       SET final_payment_status='paid', final_payment_id=$2,
           final_paid_at=NOW(), payment_status='paid', status='completed',
           completed_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [id, payment_id || `FINAL_${Date.now()}`]
    );
    try {
      const calculateEarnings = await getCalculateEarnings();
      await calculateEarnings(id);
    } catch (e) {
      console.error("Earnings after mark-final-paid failed:", e.message);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark final paid" });
  }
});

export default router;