// api/routes/earnings.js

import express from "express";
import { pool } from "../services/db.js";

const router = express.Router();

// ==================== COMMISSION CONFIG ====================
const COMMISSION_CONFIG = {
  pickdrop: { commissionPercent: 20, fixedFee: 5,  gstPercent: 18 },
  driver:   { commissionPercent: 15, fixedFee: 10, gstPercent: 18 },
  car_wash: { commissionPercent: 25, fixedFee: 0,  gstPercent: 18 },
  carwash:  { commissionPercent: 25, fixedFee: 0,  gstPercent: 18 },
  default:  { commissionPercent: 20, fixedFee: 5,  gstPercent: 18 },
};

// ── NEW HELPER ─────────────────────────────────────────────────
// Car wash is ALWAYS online (pre-paid in app) → NO dues concept
function isCarWashService(serviceType) {
  const s = (serviceType || "").toLowerCase();
  return s === "car_wash" || s === "carwash";
}

function getCommissionConfig(serviceType) {
  return COMMISSION_CONFIG[serviceType?.toLowerCase()] || COMMISSION_CONFIG.default;
}

// ==================== ENSURE WALLET ====================
async function ensureWallet(client, technicianId) {
  await client.query(
    `INSERT INTO driver_wallet (technician_id)
     VALUES ($1)
     ON CONFLICT (technician_id) DO NOTHING`,
    [technicianId]
  );
}

// ==================== RECORD WALLET TRANSACTION ====================
async function recordWalletTransaction(client, {
  technicianId, orderId, type, amount, direction,
  paymentMethod, description, metadata,
}) {
  try {
    const walletRes = await client.query(
      `SELECT online_balance, cash_balance, platform_dues, withdrawable_balance
       FROM driver_wallet WHERE technician_id = $1`,
      [technicianId]
    );
    if (!walletRes.rows.length) return;

    const w = walletRes.rows[0];

    await client.query(
      `INSERT INTO wallet_transactions
       (technician_id, order_id, type, amount, direction, payment_method,
        online_balance_after, cash_balance_after, platform_dues_after,
        withdrawable_after, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        technicianId, orderId, type, amount, direction, paymentMethod,
        parseFloat(w.online_balance)       || 0,
        parseFloat(w.cash_balance)         || 0,
        parseFloat(w.platform_dues)        || 0,
        parseFloat(w.withdrawable_balance) || 0,
        description,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch (err) {
    // Don't throw - transaction recording failure shouldn't break earnings
    console.error("recordWalletTransaction error:", err.message);
  }
}

// ==================== HANDLE CASH PAYMENT ====================
async function handleCashPayment(client, {
  orderId, technicianId, customerTotal, driverEarning,
  totalPlatformEarning, platformCommission, fixedFee, gstOnCommission,
}) {
  const walletRes = await client.query(
    `SELECT * FROM driver_wallet WHERE technician_id = $1 FOR UPDATE`,
    [technicianId]
  );
  const wallet = walletRes.rows[0];

  const prevOnline = parseFloat(wallet.online_balance)  || 0;
  const prevCash   = parseFloat(wallet.cash_balance)    || 0;
  const prevDues   = parseFloat(wallet.platform_dues)   || 0;

  const newDuesBeforeSettle = prevDues + totalPlatformEarning;
  const autoSettle          = Math.min(prevOnline, newDuesBeforeSettle);
  const finalOnline         = prevOnline - autoSettle;
  const finalDues           = newDuesBeforeSettle - autoSettle;
  const finalCash           = prevCash + customerTotal;
  const finalWithdrawable   = Math.max(0, finalOnline - finalDues);

  console.log(`   💵 CASH  fare=₹${customerTotal}  earn=₹${driverEarning}  commission=₹${totalPlatformEarning}`);
  console.log(`   📊 dues: ₹${prevDues} + ₹${totalPlatformEarning} = ₹${newDuesBeforeSettle} → settled=₹${autoSettle} → final=₹${finalDues}`);

  await client.query(
    `UPDATE driver_wallet
     SET total_earned          = total_earned          + $1,
         total_cash_collected  = total_cash_collected  + $2,
         total_commission_paid = total_commission_paid + $3,
         cash_balance          = $4,
         online_balance        = $5,
         platform_dues         = $6,
         withdrawable_balance  = $7,
         last_ride_at          = NOW(),
         updated_at            = NOW()
     WHERE technician_id = $8`,
    [
      driverEarning, customerTotal, autoSettle,
      finalCash, finalOnline, finalDues, finalWithdrawable,
      technicianId,
    ]
  );

  // Transaction 1: cash received
  await recordWalletTransaction(client, {
    technicianId, orderId, type: "cash_collection",
    amount: customerTotal, direction: "credit", paymentMethod: "cash",
    description: `Cash collected ₹${customerTotal} | Your share ₹${driverEarning} | Platform ₹${totalPlatformEarning}`,
    metadata: { customerTotal, driverEarning, totalPlatformEarning },
  });

  // Transaction 2: dues added
  await recordWalletTransaction(client, {
    technicianId, orderId, type: "platform_dues_added",
    amount: totalPlatformEarning, direction: "debit", paymentMethod: "cash",
    description: `Platform dues: commission ₹${platformCommission} + fee ₹${fixedFee} + GST ₹${gstOnCommission}`,
    metadata: { platformCommission, fixedFee, gstOnCommission, totalPlatformEarning },
  });

  // Transaction 3: auto-settle if applicable
  if (autoSettle > 0) {
    await recordWalletTransaction(client, {
      technicianId, orderId, type: "platform_dues_settled",
      amount: autoSettle, direction: "debit", paymentMethod: "auto_settle",
      description: `Auto-settled ₹${autoSettle} from online balance. Remaining dues: ₹${finalDues}`,
      metadata: { autoSettle, prevDues, finalDues },
    });

    if (finalDues === 0) {
      await client.query(
        `UPDATE platform_earnings
         SET collection_status = 'collected', collected_at = NOW()
         WHERE technician_id = $1 AND collection_status = 'pending'`,
        [technicianId]
      );
    } else {
      await client.query(
        `UPDATE platform_earnings
         SET collection_status = 'collected', collected_at = NOW()
         WHERE id IN (
           SELECT id FROM (
             SELECT id,
                    SUM(total_earning) OVER (ORDER BY created_at ASC) AS running_total
             FROM platform_earnings
             WHERE technician_id = $1 AND collection_status = 'pending'
           ) sub
           WHERE running_total <= $2
         )`,
        [technicianId, autoSettle]
      );
    }
  }
}

// ==================== HANDLE ONLINE PAYMENT ====================
async function handleOnlinePayment(client, {
  orderId, technicianId, customerTotal, driverEarning,
  totalPlatformEarning, platformCommission, fixedFee, gstOnCommission,
}) {
  const walletRes = await client.query(
    `SELECT * FROM driver_wallet WHERE technician_id = $1 FOR UPDATE`,
    [technicianId]
  );
  const wallet = walletRes.rows[0];

  const prevOnline        = parseFloat(wallet.online_balance) || 0;
  const prevDues          = parseFloat(wallet.platform_dues)  || 0;
  const autoSettle        = Math.min(driverEarning, prevDues);
  const finalDues         = prevDues - autoSettle;
  const netOnlineAdd      = driverEarning - autoSettle;
  const finalOnline       = prevOnline + netOnlineAdd;
  const finalWithdrawable = Math.max(0, finalOnline - finalDues);

  console.log(`   🌐 ONLINE  earn=₹${driverEarning}  prevDues=₹${prevDues}  autoSettle=₹${autoSettle}`);

  await client.query(
    `UPDATE driver_wallet
     SET total_earned          = total_earned          + $1,
         total_online_earned   = total_online_earned   + $2,
         total_commission_paid = total_commission_paid + $3,
         online_balance        = $4,
         platform_dues         = $5,
         withdrawable_balance  = $6,
         last_ride_at          = NOW(),
         updated_at            = NOW()
     WHERE technician_id = $7`,
    [
      driverEarning, driverEarning,
      totalPlatformEarning + autoSettle,
      finalOnline, finalDues, finalWithdrawable,
      technicianId,
    ]
  );

  await recordWalletTransaction(client, {
    technicianId, orderId, type: "ride_earning",
    amount: driverEarning, direction: "credit", paymentMethod: "online",
    description: `Online ride ₹${driverEarning} (platform kept ₹${totalPlatformEarning} from ₹${customerTotal})`,
    metadata: { customerTotal, driverEarning, platformCommission, fixedFee, netOnlineAdd },
  });

  await recordWalletTransaction(client, {
    technicianId, orderId, type: "commission_deduction",
    amount: totalPlatformEarning, direction: "debit", paymentMethod: "online",
    description: `Commission ₹${platformCommission} + fee ₹${fixedFee} + GST ₹${gstOnCommission}`,
    metadata: { platformCommission, fixedFee, gstOnCommission, totalPlatformEarning },
  });

  if (autoSettle > 0) {
    await recordWalletTransaction(client, {
      technicianId, orderId, type: "platform_dues_settled",
      amount: autoSettle, direction: "debit", paymentMethod: "auto_settle",
      description: `Auto-cleared ₹${autoSettle} from cash-ride dues. Remaining: ₹${finalDues}`,
      metadata: { autoSettle, prevDues, finalDues },
    });

    if (finalDues === 0) {
      await client.query(
        `UPDATE platform_earnings
         SET collection_status = 'collected', collected_at = NOW()
         WHERE technician_id = $1 AND collection_status = 'pending'`,
        [technicianId]
      );
    } else {
      await client.query(
        `UPDATE platform_earnings
         SET collection_status = 'collected', collected_at = NOW()
         WHERE id IN (
           SELECT id FROM (
             SELECT id,
                    SUM(total_earning) OVER (ORDER BY created_at ASC) AS running_total
             FROM platform_earnings
             WHERE technician_id = $1 AND collection_status = 'pending'
           ) sub
           WHERE running_total <= $2
         )`,
        [technicianId, autoSettle]
      );
    }
  }
}

// ==================== CALCULATE EARNINGS (exported) ====================
export async function calculateEarnings(orderId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderRes = await client.query(
      `SELECT o.id, o.price, o.service_type,
              o.payment_mode, o.payment_method,
              o.customer_total, o.pricing_breakdown,
              ot.technician_id
       FROM orders o
       LEFT JOIN order_technicians ot ON ot.order_id = o.id
       WHERE o.id = $1
       LIMIT 1`,
      [orderId]
    );

    if (!orderRes.rows.length) {
      throw new Error(`Order ${orderId} not found`);
    }

    const order = orderRes.rows[0];

    if (!order.technician_id) {
      console.warn(`⚠️  Order ${orderId} has no technician - skipping earnings`);
      await client.query("COMMIT");
      return {
        driverEarning: 0, platformCommission: 0,
        totalPlatformEarning: 0, gstOnCommission: 0,
        paymentMethod: "cash",
        customerTotal: parseFloat(order.customer_total || order.price || 0),
      };
    }

    const technicianId  = order.technician_id;
    const serviceType   = order.service_type;
    const isCarWash     = isCarWashService(serviceType);

    // ✅ Car wash is ALWAYS treated as online (pre-paid in app)
    // Even if payment_method says "cash" in DB, car wash earnings
    // go directly to wallet — NO dues added
    const paymentMethod = isCarWash
      ? "online"
      : (order.payment_method || order.payment_mode || "cash");

    const customerTotal = parseFloat(order.customer_total || order.price || 0);
    const config        = getCommissionConfig(serviceType);

    let platformCommission, fixedFee, gstOnCommission,
        totalPlatformEarning, driverEarning;

    if (order.pricing_breakdown) {
      const pb = typeof order.pricing_breakdown === "string"
        ? JSON.parse(order.pricing_breakdown)
        : order.pricing_breakdown;

      platformCommission   = parseFloat(pb.platform_commission)    || 0;
      fixedFee             = parseFloat(pb.platform_fixed_fee)     || 0;
      gstOnCommission      = parseFloat(pb.gst_on_commission)      || 0;
      totalPlatformEarning = parseFloat(pb.total_platform_earning)
                             || (platformCommission + fixedFee);
      driverEarning        = parseFloat(pb.driver_earning)
                             || (customerTotal - totalPlatformEarning);
    } else {
      platformCommission   = Math.round(customerTotal * config.commissionPercent) / 100;
      fixedFee             = config.fixedFee;
      totalPlatformEarning = platformCommission + fixedFee;
      gstOnCommission      = Math.round(totalPlatformEarning * config.gstPercent) / 100;
      driverEarning        = Math.round((customerTotal - totalPlatformEarning) * 100) / 100;
    }

    await ensureWallet(client, technicianId);

    await client.query(
      `UPDATE orders
       SET technician_earnings          = $1,
           platform_commission          = $2,
           total_platform_earning       = $3,
           driver_earning               = $4,
           gst_on_commission            = $5,
           platform_commission_percent  = $6,
           platform_fixed_fee           = $7,
           commission_rate              = $8,
           payment_method               = $9,
           customer_total               = COALESCE(customer_total, $10),
           settlement_status            = $11,
           cash_collected_by_driver     = $12,
           online_collected_by_platform = $13,
           driver_owes_platform         = $14,
           platform_owes_driver         = $15,
           completed_at = COALESCE(completed_at, wash_completed_at, NOW()),
           updated_at   = NOW()
       WHERE id = $16`,
      [
        driverEarning,
        platformCommission,
        totalPlatformEarning,
        driverEarning,
        gstOnCommission,
        config.commissionPercent,
        fixedFee,
        config.commissionPercent,
        paymentMethod,
        customerTotal,
        // ✅ Car wash always settled (online pre-paid), cash rides are pending
        paymentMethod !== "cash" ? "settled" : "pending",
        // ✅ Car wash: driver never collects cash from customer
        paymentMethod === "cash" ? customerTotal : 0,
        // ✅ Car wash: platform collected online from customer
        paymentMethod !== "cash" ? customerTotal : 0,
        // ✅ Car wash: driver owes nothing (no dues)
        paymentMethod === "cash" ? totalPlatformEarning : 0,
        paymentMethod !== "cash" ? driverEarning : 0,
        orderId,
      ]
    );

    // ✅ KEY FIX: Car wash always uses handleOnlinePayment
    // This means earnings go directly to wallet — no dues added
    if (paymentMethod === "cash") {
      // Only driver/pickdrop cash rides create dues
      await handleCashPayment(client, {
        orderId, technicianId, customerTotal, driverEarning,
        totalPlatformEarning, platformCommission, fixedFee, gstOnCommission,
      });
    } else {
      // Car wash (forced online) + actual online rides
      await handleOnlinePayment(client, {
        orderId, technicianId, customerTotal, driverEarning,
        totalPlatformEarning, platformCommission, fixedFee, gstOnCommission,
      });
    }

    // Record in platform_earnings — car wash always 'collected'
    await client.query(
      `INSERT INTO platform_earnings
       (order_id, technician_id, commission_amount, fixed_fee, gst_amount,
        total_earning, payment_method, collection_status, collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (order_id) DO UPDATE SET
         collection_status = EXCLUDED.collection_status,
         collected_at      = EXCLUDED.collected_at,
         updated_at        = NOW()`,
      [
        orderId, technicianId,
        platformCommission, fixedFee, gstOnCommission,
        totalPlatformEarning,
        paymentMethod,
        // ✅ Car wash always collected (pre-paid online)
        paymentMethod !== "cash" ? "collected" : "pending",
        paymentMethod !== "cash" ? new Date()   : null,
      ]
    );

    await client.query(
      `UPDATE technicians
       SET is_available = true, current_order_id = NULL, updated_at = NOW()
       WHERE id = $1`,
      [technicianId]
    );

    await client.query("COMMIT");

    console.log(`✅ Earnings calculated — Order ${orderId}`);
    console.log(`   Service: ${serviceType} | Payment: ${paymentMethod.toUpperCase()}`);
    console.log(`   Customer: ₹${customerTotal} | Driver: ₹${driverEarning} | Platform: ₹${totalPlatformEarning}`);
    if (isCarWash) {
      console.log(`   🚿 Car Wash — direct wallet credit, no dues`);
    }

    return {
      driverEarning, platformCommission, totalPlatformEarning,
      gstOnCommission, paymentMethod, customerTotal, technicianId,
      isCarWash,
    };

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`❌ Earnings failed for Order ${orderId}:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ==================== GET EARNINGS OVERVIEW ====================
router.get("/overview", async (req, res) => {
  const { technician_id } = req.query;
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  try {
    // Ensure wallet exists
    await pool.query(
      `INSERT INTO driver_wallet (technician_id) VALUES ($1)
       ON CONFLICT (technician_id) DO NOTHING`,
      [technician_id]
    );

    const [statsRes, walletRes, perfRes] = await Promise.all([
      pool.query(
        `SELECT
          COALESCE(SUM(CASE WHEN DATE(o.completed_at) = CURRENT_DATE
            THEN o.technician_earnings END), 0)                       AS today_earnings,
          COALESCE(SUM(CASE WHEN DATE(o.completed_at) = CURRENT_DATE
            THEN o.customer_total END), 0)                            AS today_total_fare,
          COALESCE(SUM(CASE WHEN DATE(o.completed_at) = CURRENT_DATE
            THEN o.total_platform_earning END), 0)                    AS today_commission,
          COUNT(CASE WHEN DATE(o.completed_at) = CURRENT_DATE THEN 1 END) AS today_rides,
          COALESCE(SUM(CASE WHEN DATE(o.completed_at) = CURRENT_DATE
            AND o.payment_method = 'cash' THEN o.customer_total END), 0) AS today_cash,
          COALESCE(SUM(CASE WHEN DATE(o.completed_at) = CURRENT_DATE
            AND o.payment_method != 'cash' THEN o.technician_earnings END), 0) AS today_online,

          COALESCE(SUM(CASE WHEN o.completed_at >= DATE_TRUNC('week', CURRENT_DATE)
            THEN o.technician_earnings END), 0)                       AS week_earnings,
          COUNT(CASE WHEN o.completed_at >= DATE_TRUNC('week', CURRENT_DATE)
            THEN 1 END)                                               AS week_rides,

          COALESCE(SUM(CASE WHEN o.completed_at >= DATE_TRUNC('month', CURRENT_DATE)
            THEN o.technician_earnings END), 0)                       AS month_earnings,
          COUNT(CASE WHEN o.completed_at >= DATE_TRUNC('month', CURRENT_DATE)
            THEN 1 END)                                               AS month_rides,

          COALESCE(SUM(o.technician_earnings), 0)                     AS lifetime_earnings,
          COUNT(*)                                                     AS lifetime_rides,
          COALESCE(AVG(o.technician_earnings), 0)                     AS avg_per_ride,
          COUNT(CASE WHEN o.payment_method = 'cash' THEN 1 END)       AS cash_rides,
          COUNT(CASE WHEN o.payment_method != 'cash' THEN 1 END)      AS online_rides
         FROM orders o
         JOIN order_technicians ot ON ot.order_id = o.id
         WHERE ot.technician_id = $1
           AND o.status = 'completed'
           AND o.technician_earnings IS NOT NULL`,
        [technician_id]
      ),
      pool.query(
        `SELECT * FROM driver_wallet WHERE technician_id = $1`,
        [technician_id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(CASE WHEN DATE(o.completed_at) = CURRENT_DATE - 1
           THEN o.technician_earnings END), 0) AS yesterday
         FROM orders o
         JOIN order_technicians ot ON ot.order_id = o.id
         WHERE ot.technician_id = $1 AND o.status = 'completed'`,
        [technician_id]
      ),
    ]);

    const d   = statsRes.rows[0];
    const w   = walletRes.rows[0] || {};
    const yEarn = parseFloat(perfRes.rows[0].yesterday) || 0;
    const tEarn = parseFloat(d.today_earnings) || 0;
    const change = yEarn > 0
      ? (((tEarn - yEarn) / yEarn) * 100).toFixed(1)
      : 0;

    res.json({
      today: {
        rides:         parseInt(d.today_rides)   || 0,
        earnings:      parseFloat(d.today_earnings) || 0,
        totalFare:     parseFloat(d.today_total_fare) || 0,
        commission:    parseFloat(d.today_commission) || 0,
        cashCollected: parseFloat(d.today_cash)   || 0,
        onlineEarned:  parseFloat(d.today_online) || 0,
      },
      week: {
        rides:    parseInt(d.week_rides)    || 0,
        earnings: parseFloat(d.week_earnings) || 0,
      },
      month: {
        rides:    parseInt(d.month_rides)    || 0,
        earnings: parseFloat(d.month_earnings) || 0,
      },
      lifetime: {
        rides:       parseInt(d.lifetime_rides)    || 0,
        earnings:    parseFloat(d.lifetime_earnings) || 0,
        cashRides:   parseInt(d.cash_rides)        || 0,
        onlineRides: parseInt(d.online_rides)      || 0,
        avgPerRide:  parseFloat(d.avg_per_ride)    || 0,
      },
      wallet: {
        onlineBalance:       parseFloat(w.online_balance)       || 0,
        cashBalance:         parseFloat(w.cash_balance)         || 0,
        platformDues:        parseFloat(w.platform_dues)        || 0,
        withdrawableBalance: parseFloat(w.withdrawable_balance) || 0,
        totalWithdrawn:      parseFloat(w.total_withdrawn)      || 0,
        totalCashCollected:  parseFloat(w.total_cash_collected) || 0,
        totalOnlineEarned:   parseFloat(w.total_online_earned)  || 0,
      },
      performance: {
        earningsChange: parseFloat(change),
        isUp: tEarn >= yEarn,
      },
    });
  } catch (err) {
    console.error("EARNINGS OVERVIEW ERROR:", err);
    res.status(500).json({ error: "Failed to fetch earnings", details: err.message });
  }
});

// ==================== GET WALLET ====================
router.get("/wallet", async (req, res) => {
  const { technician_id } = req.query;
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  try {
    await pool.query(
      `INSERT INTO driver_wallet (technician_id) VALUES ($1)
       ON CONFLICT (technician_id) DO NOTHING`,
      [technician_id]
    );

    const [walletRes, txnRes, duesRes, withdrawRes] = await Promise.all([
      pool.query(`SELECT * FROM driver_wallet WHERE technician_id = $1`, [technician_id]),
      pool.query(
        `SELECT * FROM wallet_transactions
         WHERE technician_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [technician_id]
      ),
      pool.query(
        `SELECT o.id AS order_id, o.customer_total,
                pe.total_earning AS dues_amount, pe.payment_method,
                pe.created_at AS ride_date, pe.collection_status
         FROM platform_earnings pe
         JOIN orders o ON o.id = pe.order_id
         WHERE pe.technician_id = $1 AND pe.collection_status = 'pending'
         ORDER BY pe.created_at ASC`,
        [technician_id]
      ),
      pool.query(
        `SELECT * FROM withdrawals
         WHERE technician_id = $1 AND status IN ('pending','processing')
         ORDER BY created_at DESC`,
        [technician_id]
      ),
    ]);

    const wallet = walletRes.rows[0] || {};
    const pendingDuesTotal = duesRes.rows.reduce(
      (sum, r) => sum + parseFloat(r.dues_amount || 0), 0
    );

    res.json({
      wallet: {
        onlineBalance:       parseFloat(wallet.online_balance)        || 0,
        cashBalance:         parseFloat(wallet.cash_balance)          || 0,
        platformDues:        parseFloat(wallet.platform_dues)         || 0,
        withdrawableBalance: parseFloat(wallet.withdrawable_balance)  || 0,
        totalEarned:         parseFloat(wallet.total_earned)          || 0,
        totalCashCollected:  parseFloat(wallet.total_cash_collected)  || 0,
        totalOnlineEarned:   parseFloat(wallet.total_online_earned)   || 0,
        totalCommissionPaid: parseFloat(wallet.total_commission_paid) || 0,
        totalWithdrawn:      parseFloat(wallet.total_withdrawn)       || 0,
        lastRideAt:          wallet.last_ride_at,
        lastWithdrawalAt:    wallet.last_withdrawal_at,
      },
      recentTransactions: txnRes.rows,
      pendingDues:        duesRes.rows,
      pendingDuesTotal,
      pendingWithdrawals: withdrawRes.rows,
      explanation: {
        formula:      "Withdrawable = Online Balance − Platform Dues",
        onlineBalance: parseFloat(wallet.online_balance)  || 0,
        platformDues:  parseFloat(wallet.platform_dues)   || 0,
        note: parseFloat(wallet.platform_dues) > 0
          ? `You owe ₹${wallet.platform_dues} from cash rides. Auto-deducted from next online earnings.`
          : "No pending dues. All commission settled!",
      },
    });
  } catch (err) {
    console.error("WALLET ERROR:", err);
    res.status(500).json({ error: "Failed to fetch wallet", details: err.message });
  }
});

// ==================== WITHDRAW ====================
router.post("/withdraw", async (req, res) => {
  const { technician_id, amount, upi_id, bank_account, ifsc_code } = req.body;

  if (!technician_id || !amount)
    return res.status(400).json({ error: "technician_id and amount required" });
  if (amount < 100)
    return res.status(400).json({ error: "Minimum withdrawal is ₹100" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const walletRes = await client.query(
      `SELECT * FROM driver_wallet WHERE technician_id = $1 FOR UPDATE`,
      [technician_id]
    );
    if (!walletRes.rows.length) throw new Error("Wallet not found");

    const wallet      = walletRes.rows[0];
    const withdrawable = parseFloat(wallet.withdrawable_balance) || 0;

    if (amount > withdrawable) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "INSUFFICIENT_BALANCE",
        message: `Max withdrawable: ₹${withdrawable}`,
        details: {
          requested:     amount,
          available:     withdrawable,
          onlineBalance: parseFloat(wallet.online_balance) || 0,
          platformDues:  parseFloat(wallet.platform_dues)  || 0,
        },
      });
    }

    const pendingRes = await client.query(
      `SELECT id FROM withdrawals
       WHERE technician_id = $1 AND status IN ('pending','processing')`,
      [technician_id]
    );
    if (pendingRes.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "PENDING_WITHDRAWAL",
        message: "Wait for current withdrawal to complete.",
      });
    }

    const newOnline      = parseFloat(wallet.online_balance) - amount;
    const newWithdrawable = Math.max(0, newOnline - parseFloat(wallet.platform_dues));

    await client.query(
      `UPDATE driver_wallet
       SET online_balance       = $1,
           withdrawable_balance = $2,
           total_withdrawn      = total_withdrawn + $3,
           last_withdrawal_at   = NOW(),
           updated_at           = NOW()
       WHERE technician_id = $4`,
      [newOnline, newWithdrawable, amount, technician_id]
    );

    const wdRes = await client.query(
      `INSERT INTO withdrawals
       (technician_id, amount,
        online_balance_before, platform_dues_before, withdrawable_before,
        online_balance_after,  platform_dues_after,  withdrawable_after,
        upi_id, bank_account, ifsc_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
       RETURNING id`,
      [
        technician_id, amount,
        wallet.online_balance, wallet.platform_dues, wallet.withdrawable_balance,
        newOnline, wallet.platform_dues, newWithdrawable,
        upi_id || null, bank_account || null, ifsc_code || null,
      ]
    );

    await recordWalletTransaction(client, {
      technicianId: technician_id, orderId: null,
      type: "withdrawal", amount, direction: "debit",
      paymentMethod: upi_id ? "upi" : "bank",
      description: `Withdrawal ₹${amount} to ${upi_id || bank_account}`,
      metadata: { withdrawalId: wdRes.rows[0].id },
    });

    await client.query("COMMIT");

    res.json({
      success: true,
      withdrawalId: wdRes.rows[0].id,
      amount,
      newBalance: { onlineBalance: newOnline, withdrawable: newWithdrawable },
      message: `₹${amount} withdrawal initiated. Processed within 24 hours.`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("WITHDRAWAL ERROR:", err);
    res.status(500).json({ error: "Withdrawal failed", details: err.message });
  } finally {
    client.release();
  }
});

// ==================== WITHDRAWAL HISTORY ====================
router.get("/withdrawals", async (req, res) => {
  const { technician_id, limit = 20, offset = 0 } = req.query;
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  try {
    const [result, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM withdrawals WHERE technician_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [technician_id, parseInt(limit), parseInt(offset)]
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM withdrawals WHERE technician_id = $1`,
        [technician_id]
      ),
    ]);

    res.json({ withdrawals: result.rows, total: parseInt(countRes.rows[0].total) });
  } catch (err) {
    console.error("WITHDRAWAL HISTORY ERROR:", err);
    res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
});

// ==================== WALLET TRANSACTIONS ====================
router.get("/transactions", async (req, res) => {
  const { technician_id, type, limit = 30, offset = 0 } = req.query;
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  try {
    const params = [technician_id, parseInt(limit), parseInt(offset)];
    let typeFilter = "";

    if (type) {
      typeFilter = "AND wt.type = $4";
      params.push(type);
    }

    const result = await pool.query(
      `SELECT wt.*, o.pickup_address, o.drop_address, o.service_type
       FROM wallet_transactions wt
       LEFT JOIN orders o ON o.id = wt.order_id
       WHERE wt.technician_id = $1 ${typeFilter}
       ORDER BY wt.created_at DESC LIMIT $2 OFFSET $3`,
      params
    );

    res.json({ transactions: result.rows });
  } catch (err) {
    console.error("TRANSACTIONS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ==================== WEEKLY BREAKDOWN ====================
router.get("/weekly", async (req, res) => {
  const { technician_id } = req.query;
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  try {
    const result = await pool.query(
      `WITH date_series AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '6 days',
          CURRENT_DATE,
          '1 day'::interval
        )::date AS date
      )
      SELECT
        ds.date,
        TO_CHAR(ds.date, 'Dy')    AS day_name,
        TO_CHAR(ds.date, 'DD Mon') AS date_label,
        COALESCE(COUNT(o.id), 0)                                             AS rides,
        COALESCE(SUM(o.technician_earnings), 0)                              AS earnings,
        COALESCE(SUM(o.customer_total), 0)                                   AS total_fare,
        COALESCE(SUM(CASE WHEN o.payment_method = 'cash'
          THEN o.customer_total END), 0)                                     AS cash_collected,
        COALESCE(SUM(CASE WHEN o.payment_method != 'cash'
          THEN o.technician_earnings END), 0)                                AS online_earned,
        COALESCE(SUM(o.total_platform_earning), 0)                           AS commission
      FROM date_series ds
      LEFT JOIN orders o
        ON  DATE(o.completed_at) = ds.date
        AND o.status = 'completed'
        AND o.id IN (
          SELECT order_id FROM order_technicians WHERE technician_id = $1
        )
      GROUP BY ds.date
      ORDER BY ds.date ASC`,
      [technician_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("WEEKLY ERROR:", err);
    res.status(500).json({ error: "Failed to fetch weekly earnings" });
  }
});

// ==================== MONTHLY BREAKDOWN ====================
router.get("/monthly", async (req, res) => {
  const { technician_id, year, month } = req.query;
  const targetYear  = parseInt(year)  || new Date().getFullYear();
  const targetMonth = parseInt(month) || new Date().getMonth() + 1;

  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  try {
    const result = await pool.query(
      `WITH date_series AS (
        SELECT generate_series(
          DATE_TRUNC('month', make_date($2::int, $3::int, 1)),
          DATE_TRUNC('month', make_date($2::int, $3::int, 1))
            + INTERVAL '1 month' - INTERVAL '1 day',
          '1 day'::interval
        )::date AS date
      )
      SELECT
        EXTRACT(DAY FROM ds.date)  AS day,
        TO_CHAR(ds.date, 'DD')    AS day_label,
        COALESCE(COUNT(o.id), 0)  AS rides,
        COALESCE(SUM(o.technician_earnings), 0) AS earnings
      FROM date_series ds
      LEFT JOIN orders o
        ON  DATE(o.completed_at) = ds.date
        AND o.status = 'completed'
        AND o.id IN (
          SELECT order_id FROM order_technicians WHERE technician_id = $1
        )
      WHERE ds.date <= CURRENT_DATE
      GROUP BY ds.date
      ORDER BY ds.date ASC`,
      [technician_id, targetYear, targetMonth]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("MONTHLY ERROR:", err);
    res.status(500).json({ error: "Failed to fetch monthly earnings" });
  }
});

// ==================== YEARLY BREAKDOWN ====================
router.get("/yearly", async (req, res) => {
  const { technician_id, year } = req.query;
  const targetYear = parseInt(year) || new Date().getFullYear();

  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  try {
    const result = await pool.query(
      `WITH month_series AS (
        SELECT generate_series(1, 12) AS month_num
      )
      SELECT
        ms.month_num                                            AS month,
        TO_CHAR(make_date($2::int, ms.month_num::int, 1), 'Mon') AS month_name,
        COALESCE(COUNT(o.id), 0)                               AS rides,
        COALESCE(SUM(o.technician_earnings), 0)                AS earnings
      FROM month_series ms
      LEFT JOIN orders o
        ON  EXTRACT(MONTH FROM o.completed_at) = ms.month_num
        AND EXTRACT(YEAR  FROM o.completed_at) = $2
        AND o.status = 'completed'
        AND o.id IN (
          SELECT order_id FROM order_technicians WHERE technician_id = $1
        )
      WHERE ms.month_num <= EXTRACT(MONTH FROM CURRENT_DATE)
         OR $2 < EXTRACT(YEAR FROM CURRENT_DATE)
      GROUP BY ms.month_num
      ORDER BY ms.month_num ASC`,
      [technician_id, targetYear]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("YEARLY ERROR:", err);
    res.status(500).json({ error: "Failed to fetch yearly earnings" });
  }
});

// ==================== RIDE HISTORY ====================
router.get("/history", async (req, res) => {
  const { technician_id, limit = 50, offset = 0, period } = req.query;
  if (!technician_id) return res.status(400).json({ error: "technician_id required" });

  let dateFilter = "";
  if (period === "today")
    dateFilter = "AND DATE(o.completed_at) = CURRENT_DATE";
  else if (period === "week")
    dateFilter = "AND o.completed_at >= DATE_TRUNC('week', CURRENT_DATE)";
  else if (period === "month")
    dateFilter = "AND o.completed_at >= DATE_TRUNC('month', CURRENT_DATE)";

  try {
    const [result, countRes] = await Promise.all([
      pool.query(
        `SELECT
          o.id, o.service_type, o.distance, o.price,
          o.customer_total                AS total_fare,
          o.technician_earnings, o.platform_commission,
          o.total_platform_earning,       o.commission_rate,
          o.payment_method,               o.pickup_address, o.drop_address,
          o.completed_at,                 o.created_at,
          o.cash_collected_by_driver,     o.online_collected_by_platform,
          o.driver_owes_platform,         o.settlement_status,
          u.name  AS customer_name,
          u.phone AS customer_phone
         FROM orders o
         JOIN order_technicians ot ON ot.order_id = o.id
         LEFT JOIN users u ON u.id = o.user_id
         WHERE ot.technician_id = $1
           AND o.status = 'completed'
           ${dateFilter}
         ORDER BY o.completed_at DESC
         LIMIT $2 OFFSET $3`,
        [technician_id, parseInt(limit), parseInt(offset)]
      ),
      pool.query(
        `SELECT COUNT(*) AS total
         FROM orders o
         JOIN order_technicians ot ON ot.order_id = o.id
         WHERE ot.technician_id = $1 AND o.status = 'completed' ${dateFilter}`,
        [technician_id]
      ),
    ]);

    res.json({
      rides:  result.rows,
      total:  parseInt(countRes.rows[0].total),
      limit:  parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    console.error("HISTORY ERROR:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ==================== ORDER BREAKDOWN ====================
router.get("/breakdown/:orderId", async (req, res) => {
  const { orderId } = req.params;

  try {
    const result = await pool.query(
      `SELECT
        o.id, o.service_type, o.price,
        o.customer_total              AS total_fare,
        o.technician_earnings,         o.platform_commission,
        o.platform_fixed_fee,          o.total_platform_earning,
        o.gst_on_commission,           o.commission_rate,
        o.payment_method,              o.cash_collected_by_driver,
        o.online_collected_by_platform,o.driver_owes_platform,
        o.platform_owes_driver,        o.settlement_status,
        o.pricing_breakdown,           o.completed_at,
        u.name AS customer_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.id = $1`,
      [orderId]
    );

    if (!result.rows.length)
      return res.status(404).json({ error: "Order not found" });

    const o = result.rows[0];

    res.json({
      orderId:      o.id,
      serviceType:  o.service_type,
      customerName: o.customer_name,
      completedAt:  o.completed_at,
      paymentMethod:o.payment_method,
      breakdown: {
        customerPaid:         parseFloat(o.total_fare)              || parseFloat(o.price) || 0,
        platformCommission:   parseFloat(o.platform_commission)     || 0,
        platformFixedFee:     parseFloat(o.platform_fixed_fee)      || 0,
        totalPlatformEarning: parseFloat(o.total_platform_earning)  || 0,
        gstOnCommission:      parseFloat(o.gst_on_commission)       || 0,
        commissionRate:       parseFloat(o.commission_rate)         || 0,
        yourEarnings:         parseFloat(o.technician_earnings)     || 0,
      },
      settlement: {
        cashCollected:      parseFloat(o.cash_collected_by_driver)      || 0,
        onlineCollected:    parseFloat(o.online_collected_by_platform)   || 0,
        driverOwesPlatform: parseFloat(o.driver_owes_platform)          || 0,
        platformOwesDriver: parseFloat(o.platform_owes_driver)          || 0,
        status: o.settlement_status,
      },
      pricingBreakdown: o.pricing_breakdown,
    });
  } catch (err) {
    console.error("BREAKDOWN ERROR:", err);
    res.status(500).json({ error: "Failed to fetch breakdown" });
  }
});

// ==================== PLATFORM OVERVIEW (admin) ====================
router.get("/platform/overview", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN DATE(created_at) = CURRENT_DATE THEN total_earning END), 0)        AS today_earnings,
        COUNT(CASE WHEN DATE(created_at) = CURRENT_DATE THEN 1 END)                               AS today_orders,
        COALESCE(SUM(CASE WHEN DATE(created_at) = CURRENT_DATE
          AND collection_status = 'collected' THEN total_earning END), 0)                          AS today_collected,
        COALESCE(SUM(CASE WHEN DATE(created_at) = CURRENT_DATE
          AND collection_status = 'pending'   THEN total_earning END), 0)                          AS today_pending,
        COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('week',  CURRENT_DATE) THEN total_earning END), 0) AS week_earnings,
        COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN total_earning END), 0) AS month_earnings,
        COALESCE(SUM(total_earning), 0)                                                            AS lifetime_earnings,
        COUNT(*)                                                                                   AS total_orders,
        COALESCE(SUM(CASE WHEN collection_status = 'collected' THEN total_earning END), 0)         AS total_collected,
        COALESCE(SUM(CASE WHEN collection_status = 'pending'   THEN total_earning END), 0)         AS total_pending,
        COALESCE(SUM(CASE WHEN payment_method  = 'cash' THEN total_earning END), 0)               AS from_cash_rides,
        COALESCE(SUM(CASE WHEN payment_method != 'cash' THEN total_earning END), 0)               AS from_online_rides,
        COALESCE(SUM(gst_amount), 0)                                                              AS total_gst_collected
       FROM platform_earnings`
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PLATFORM OVERVIEW ERROR:", err);
    res.status(500).json({ error: "Failed to fetch platform earnings" });
  }
});

// ==================== PLATFORM PENDING (admin) ====================
router.get("/platform/pending", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        pe.technician_id,
        t.full_name                 AS driver_name,
        t.phone                     AS driver_phone,
        COUNT(*)                    AS pending_rides,
        SUM(pe.total_earning)       AS total_pending,
        MIN(pe.created_at)          AS oldest_pending,
        dw.online_balance           AS driver_online_balance,
        dw.platform_dues            AS driver_platform_dues
       FROM platform_earnings pe
       JOIN technicians t  ON t.id  = pe.technician_id
       LEFT JOIN driver_wallet dw ON dw.technician_id = pe.technician_id
       WHERE pe.collection_status = 'pending'
       GROUP BY pe.technician_id, t.full_name, t.phone,
                dw.online_balance, dw.platform_dues
       ORDER BY total_pending DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error("PENDING COLLECTIONS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch pending collections" });
  }
});

export default router;