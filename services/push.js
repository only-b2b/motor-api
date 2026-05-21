// api/services/push.js

import admin from "./firebaseAdmin.js";

/* =========================================
   SEND RIDE REQUEST TO DRIVER
========================================= */
export async function sendRideRequestPush(token, order) {
  try {
    const isScheduled = order.is_scheduled || false;
    const price = order.customer_total || order.price || "";

    const message = {
      token,
      notification: {
        title: isScheduled
          ? "📅 Scheduled Ride Request"
          : "🚗 New Ride Request",
        body: isScheduled
          ? `Scheduled ride • ₹${price}`
          : `New request • ₹${price}`,
      },
      data: {
        type: "NEW_ORDER",
        orderId: String(order.id),
        service_type: order.service_type || "",
        price: String(price),
        distance: String(order.distance || ""),
        duration: String(order.duration || ""),
        vehicle: order.vehicle || "",
        package_name: order.package_name || "",
        pickup_address: order.pickup_address || "",
        drop_address: order.drop_address || "",
        pickup_lat: String(order.pickup_lat || ""),
        pickup_lng: String(order.pickup_lng || ""),
        drop_lat: String(order.drop_lat || ""),
        drop_lng: String(order.drop_lng || ""),
        is_scheduled: String(isScheduled),
        scheduled_date: order.scheduled_date
          ? String(order.scheduled_date)
          : "",
      },
      android: {
        priority: "high",
      },
      apns: {
        headers: {
          "apns-priority": "10",
        },
      },
    };

    console.log("📤 Sending ride request push to:", token);
    return await admin.messaging().send(message);
  } catch (err) {
    console.error("❌ Ride request push error:", err);
  }
}

/* =========================================
   SEND RIDE CONFIRMED TO USER
========================================= */
export async function sendRideConfirmedPush(token, {
  orderId,
  driverName,
  driverPhone,
  isScheduled,
  scheduledDate,
  otp,
}) {
  try {
    const message = {
      token,
      notification: {
        title: isScheduled
          ? "✅ Driver Confirmed for Scheduled Ride"
          : "🚗 Driver is on the way!",
        body: isScheduled
          ? `${driverName} will pick you up at ${new Date(scheduledDate).toLocaleString()}`
          : `${driverName} accepted your request. OTP: ${otp}`,
      },
      data: {
        type: "RIDE_CONFIRMED",
        orderId: String(orderId),
        driverName: driverName || "",
        driverPhone: driverPhone || "",
        otp: otp ? String(otp) : "",
        is_scheduled: String(isScheduled),
      },
      android: { priority: "high" },
      apns: { headers: { "apns-priority": "10" } },
    };

    console.log("📤 Sending ride confirmed push to user");
    return await admin.messaging().send(message);
  } catch (err) {
    console.error("❌ Ride confirmed push error:", err);
  }
}

/* =========================================
   UPCOMING RIDE REMINDER TO DRIVER
========================================= */
export async function sendUpcomingRideReminderPush(token, {
  orderId,
  scheduledDate,
  pickupAddress,
  customerName,
  price,
}) {
  try {
    const message = {
      token,
      notification: {
        title: "⏰ Upcoming Ride Reminder",
        body: `Ride with ${customerName} at ${new Date(
          scheduledDate
        ).toLocaleTimeString()}`,
      },
      data: {
        type: "UPCOMING_RIDE_REMINDER",
        orderId: String(orderId),
        scheduledDate: String(scheduledDate),
        pickupAddress: pickupAddress || "",
        price: String(price || ""),
      },
      android: { priority: "high" },
      apns: { headers: { "apns-priority": "10" } },
    };

    console.log("📤 Sending upcoming reminder push");
    return await admin.messaging().send(message);
  } catch (err) {
    console.error("❌ Upcoming reminder push error:", err);
  }
}