// api/services/scheduledOrdersService.js

import { pool } from "./db.js";

const getCategoryVariants = (serviceType) => {
  if (!serviceType) return [];
  const s = serviceType.toLowerCase().trim();
  const map = {
    driver:    ["driver"],
    car_wash:  ["car_wash", "carwash"],
    carwash:   ["car_wash", "carwash"],
    pickdrop:  ["pickdrop", "pick_drop"],
    pick_drop: ["pickdrop", "pick_drop"],
    ride:      ["ride"],
  };
  return map[s] || [s];
};

// ==================== UPCOMING RIDE REMINDERS ====================
// Runs every 5 min - sends reminder 1 hour before scheduled ride
const sendUpcomingRideReminders = async () => {
  try {
    const { rows } = await pool.query(
      `SELECT
        o.id, o.scheduled_date, o.pickup_address,
        o.customer_total, o.price,
        u.name            AS client_name,
        t.push_token      AS driver_token,
        t.full_name       AS driver_name,
        u.push_token      AS user_token
       FROM orders o
       JOIN order_technicians ot ON ot.order_id = o.id
       JOIN technicians t        ON t.id  = ot.technician_id
       JOIN users u              ON u.id  = o.user_id
       WHERE o.is_scheduled = true
         AND o.status       = 'accepted'
         AND o.scheduled_date >  NOW() + INTERVAL '55 minutes'
         AND o.scheduled_date <= NOW() + INTERVAL '60 minutes'`
    );

    if (!rows.length) return;

    console.log(`⏰ Sending ${rows.length} upcoming ride reminder(s)`);

    let pushModule = null;
    try { pushModule = await import("./push.js"); } catch (e) { return; }

    for (const ride of rows) {
      // Remind driver
      if (ride.driver_token) {
        try {
          await pushModule.sendUpcomingRideReminderPush(ride.driver_token, {
            orderId:       ride.id,
            scheduledDate: ride.scheduled_date,
            pickupAddress: ride.pickup_address,
            customerName:  ride.client_name,
            price:         parseFloat(ride.customer_total || ride.price || 0),
          });
          console.log(`   ✅ Driver reminder → ${ride.driver_name} | Order ${ride.id}`);
        } catch (e) {
          console.error(`   ❌ Driver reminder failed | Order ${ride.id}:`, e.message);
        }
      }

      // Remind customer
      if (ride.user_token) {
        try {
          const admin = (await import("./firebaseAdmin.js")).default;
          await admin.messaging().send({
            token: ride.user_token,
            notification: {
              title: "⏰ Your Ride Starts Soon",
              body:  `Your driver will arrive in about 1 hour. Be ready!`,
            },
            data: {
              type:    "RIDE_REMINDER",
              orderId: String(ride.id),
            },
            android: { priority: "high" },
            apns:    { headers: { "apns-priority": "10" } },
          });
          console.log(`   ✅ Customer reminder sent | Order ${ride.id}`);
        } catch (e) {
          console.error(`   ❌ Customer reminder failed | Order ${ride.id}:`, e.message);
        }
      }
    }
  } catch (err) {
    console.error("Upcoming ride reminders error:", err.message);
  }
};

// ==================== CANCEL EXPIRED ORDERS ====================
// Runs every 5 min - cancels orders with no driver after 15 min
const cancelExpiredOrders = async () => {
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE orders
       SET status              = 'cancelled',
           cancellation_reason = 'No driver available - request expired',
           cancelled_at        = NOW(),
           updated_at          = NOW()
       WHERE status     = 'requested'
         AND created_at < NOW() - INTERVAL '15 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM order_technicians ot
           WHERE ot.order_id = orders.id
         )
       RETURNING id, service_type, is_scheduled, user_id`
    );

    if (!rowCount) return;

    console.log(`⏱️  Auto-cancelled ${rowCount} expired order(s)`);

    let admin = null;
    try { admin = (await import("./firebaseAdmin.js")).default; } catch (e) {}

    for (const order of rows) {
      if (!admin) continue;

      try {
        const { rows: userRows } = await pool.query(
          `SELECT push_token, name FROM users WHERE id = $1`,
          [order.user_id]
        );

        if (!userRows[0]?.push_token) continue;

        await admin.messaging().send({
          token: userRows[0].push_token,
          notification: {
            title: "❌ No Driver Found",
            body: order.is_scheduled
              ? "Sorry, no driver was available for your scheduled ride. Please try booking again."
              : "No driver was available. Please try again.",
          },
          data: {
            type:    "ORDER_EXPIRED",
            orderId: String(order.id),
          },
          android: { priority: "high" },
          apns:    { headers: { "apns-priority": "10" } },
        });

        console.log(`   ✅ Expiry notification sent to ${userRows[0].name}`);
      } catch (e) {
        console.error(`   ❌ Expiry notify failed for order ${order.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error("Cancel expired orders error:", err.message);
  }
};

// ==================== CHECK SCHEDULED ORDERS (debug log) ====================
export const checkScheduledOrders = async () => {
  try {
    const { rows } = await pool.query(
      `SELECT id, service_type, status, scheduled_date, is_scheduled
       FROM orders
       WHERE is_scheduled = true
         AND status IN ('created', 'requested', 'accepted')
       ORDER BY scheduled_date ASC
       LIMIT 10`
    );

    if (!rows.length) return;

    console.log(`\n📅 UPCOMING SCHEDULED ORDERS (${rows.length}):`);
    rows.forEach((o) => {
      const min = Math.round(
        (new Date(o.scheduled_date) - new Date()) / 60000
      );
      const label =
        min > 0
          ? `in ${min >= 60 ? Math.floor(min / 60) + "h " + (min % 60) + "m" : min + " min"}`
          : `overdue ${Math.abs(min)} min`;

      console.log(
        `   Order ${o.id} | ${o.service_type} | ${o.status} | ${label}`
      );
    });
    console.log("");
  } catch (err) {
    console.error("Check scheduled orders error:", err.message);
  }
};

// ==================== EXPORTS ====================

// ✅ Scheduled orders now go to 'requested' IMMEDIATELY on booking
// No need for a release cron - that's handled in the booking flow
// This service only handles: reminders + expiry + monitoring

export const startScheduledOrdersJob = () => {
  // Kept for backward compatibility but does nothing now
  // Orders are released immediately when booked
  console.log("✅ Scheduled orders: requests sent immediately on booking");
};

export const startExpiredOrdersJob = () => {
  setInterval(cancelExpiredOrders, 5 * 60 * 1000);
  cancelExpiredOrders();
  console.log("✅ Expired orders job started (every 5 min)");
};

export const startScheduledOrdersMonitor = () => {
  // Send reminders 1 hour before ride
  setInterval(sendUpcomingRideReminders, 5 * 60 * 1000);
  sendUpcomingRideReminders();

  // Log upcoming scheduled orders every 10 min
  setInterval(checkScheduledOrders, 10 * 60 * 1000);
  checkScheduledOrders();

  console.log("✅ Scheduled orders monitor started (reminders: 5 min | check: 10 min)");
};