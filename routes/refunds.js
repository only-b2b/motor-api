// api/routes/refunds.js
import express from "express";
import { pool } from "../services/db.js";
import Razorpay from "razorpay";

const router = express.Router();

// Initialize Razorpay (handle missing credentials gracefully)
let razorpay = null;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log("✅ Razorpay initialized");
  } else {
    console.log("⚠️ Razorpay credentials not found - running in test mode");
  }
} catch (err) {
  console.log("⚠️ Razorpay initialization failed:", err.message);
}

// Refund configuration
const REFUND_CONFIG = {
  FULL_REFUND_STATUSES: ['created', 'requested'],
  PARTIAL_REFUND_STATUSES: ['accepted', 'arrived'],
  NO_REFUND_STATUSES: ['in_progress', 'completed', 'cancelled'],
  CANCELLATION_CHARGE_PERCENT: 5,
};

/**
 * Calculate refund details based on order status
 */
const calculateRefundDetails = (advanceAmount, orderStatus) => {
  let chargePercentage = 0;
  let isRefundable = true;
  let refundType = 'full';

  if (REFUND_CONFIG.FULL_REFUND_STATUSES.includes(orderStatus)) {
    // Full refund - before technician accepts
    chargePercentage = 0;
    refundType = 'full';
  } else if (REFUND_CONFIG.PARTIAL_REFUND_STATUSES.includes(orderStatus)) {
    // Partial refund - after technician accepts (5% charge)
    chargePercentage = REFUND_CONFIG.CANCELLATION_CHARGE_PERCENT;
    refundType = 'partial';
  } else {
    // No refund - service in progress or completed
    isRefundable = false;
    chargePercentage = 100;
    refundType = 'none';
  }

  const cancellationCharge = Math.round((advanceAmount * chargePercentage) / 100);
  const refundAmount = advanceAmount - cancellationCharge;

  return {
    advanceAmount,
    chargePercentage,
    cancellationCharge,
    refundAmount,
    isRefundable,
    refundType,
  };
};

/**
 * Check if we're in test/development mode (no real payment)
 */
const isTestPayment = (paymentId) => {
  if (!paymentId) return true;
  if (paymentId.startsWith('test_')) return true;
  if (paymentId.startsWith('sim_')) return true;
  if (paymentId === 'simulated') return true;
  return false;
};

/* =========================
   GET CANCELLATION PREVIEW
========================= */
router.get("/preview/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);

  try {
    const orderRes = await pool.query(
      `SELECT 
        id, status, price, advance_amount, advance_payment_id,
        advance_payment_status, service_type, package_name, vehicle,
        created_at
       FROM orders WHERE id = $1`,
      [orderId]
    );

    if (!orderRes.rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderRes.rows[0];

    // Check if already cancelled
    if (order.status === 'cancelled') {
      return res.status(400).json({ 
        error: "Order already cancelled",
      });
    }

    // Calculate advance amount
    const advanceAmount = order.advance_amount || Math.round(order.price * 0.3333);
    
    // Check if there's any payment to refund
    const hasPayment = order.advance_payment_status === 'paid' && advanceAmount > 0;

    if (!hasPayment) {
      // No payment - just cancel without refund
      return res.json({
        orderId: order.id,
        orderStatus: order.status,
        serviceType: order.service_type,
        packageName: order.package_name,
        vehicle: order.vehicle,
        createdAt: order.created_at,
        advanceAmount: 0,
        chargePercentage: 0,
        cancellationCharge: 0,
        refundAmount: 0,
        isRefundable: true,
        hasPayment: false,
        message: "No payment to refund - Order will be cancelled",
      });
    }

    const refundDetails = calculateRefundDetails(advanceAmount, order.status);

    res.json({
      orderId: order.id,
      orderStatus: order.status,
      serviceType: order.service_type,
      packageName: order.package_name,
      vehicle: order.vehicle,
      createdAt: order.created_at,
      hasPayment: true,
      isTestPayment: isTestPayment(order.advance_payment_id),
      ...refundDetails,
      message: refundDetails.isRefundable
        ? refundDetails.chargePercentage === 0
          ? "Full refund - Technician not yet assigned"
          : `${refundDetails.chargePercentage}% cancellation charge applies`
        : "Service already started - No refund available",
    });

  } catch (err) {
    console.error("REFUND PREVIEW ERROR:", err);
    res.status(500).json({ error: "Failed to get refund preview" });
  }
});

/* =========================
   CANCEL ORDER & INITIATE REFUND
========================= */
router.post("/cancel/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);
  const { reason = "User requested cancellation", cancelled_by = "user" } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Get order details with lock
    const orderRes = await client.query(
      `SELECT 
        id, status, price, advance_amount, advance_payment_id,
        advance_payment_status, user_id, service_type, package_name
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );

    if (!orderRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderRes.rows[0];

    // Validate order can be cancelled
    if (order.status === 'cancelled') {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order already cancelled" });
    }

    if (order.status === 'completed') {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cannot cancel completed order" });
    }

    if (REFUND_CONFIG.NO_REFUND_STATUSES.includes(order.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        error: "Cannot cancel at this stage",
        message: "Service is already in progress",
      });
    }

    // Calculate advance amount
    const advanceAmount = order.advance_amount || Math.round(order.price * 0.3333);
    
    // Check if advance was paid
    const hasPayment = order.advance_payment_status === 'paid' && advanceAmount > 0;

    if (!hasPayment) {
      // No payment to refund - just cancel the order
      await client.query(
        `UPDATE orders 
         SET status = 'cancelled',
             cancelled_at = NOW(),
             cancelled_by = $2,
             cancellation_reason = $3
         WHERE id = $1`,
        [orderId, cancelled_by, reason]
      );

      await client.query("COMMIT");
      
      console.log(`✅ Order ${orderId} cancelled (no payment to refund)`);

      return res.json({
        success: true,
        message: "Order cancelled successfully (no payment to refund)",
        refund: null,
      });
    }

    // Calculate refund details
    const refundDetails = calculateRefundDetails(advanceAmount, order.status);

    // Check if this is a test/simulated payment
    const testPayment = isTestPayment(order.advance_payment_id);
    
    let razorpayRefund = null;
    let refundStatus = 'initiated';

    // Only attempt Razorpay refund if:
    // 1. We have a valid Razorpay instance
    // 2. There's an actual payment ID (not test)
    // 3. Refund amount > 0
    if (razorpay && !testPayment && order.advance_payment_id && refundDetails.refundAmount > 0) {
      try {
        console.log(`💳 Initiating Razorpay refund for payment: ${order.advance_payment_id}`);
        
        razorpayRefund = await razorpay.payments.refund(order.advance_payment_id, {
          amount: refundDetails.refundAmount * 100, // Convert to paise
          speed: "normal",
          notes: {
            order_id: orderId.toString(),
            reason: reason,
            charge_percentage: refundDetails.chargePercentage.toString(),
          },
        });

        refundStatus = 'processing';
        console.log(`✅ Razorpay refund initiated: ${razorpayRefund.id}`);
        
      } catch (razorpayError) {
        console.error("Razorpay refund error:", {
          statusCode: razorpayError.statusCode,
          error: razorpayError.error,
          message: razorpayError.message,
        });

        // If Razorpay refund fails, we still allow cancellation
        // but mark refund for manual processing
        console.log("⚠️ Razorpay refund failed - will process manually or mark as test");
        
        // For test payments or failed Razorpay, mark as completed immediately
        refundStatus = testPayment ? 'completed' : 'manual_required';
      }
    } else {
      // Test payment or no Razorpay - mark refund as completed immediately
      console.log(`📝 Test/simulated payment - marking refund as completed immediately`);
      refundStatus = 'completed';
    }

    // Create refund record
    const refundRes = await client.query(
      `INSERT INTO refunds (
        order_id, user_id, original_payment_id, razorpay_refund_id,
        advance_amount, cancellation_charge, refund_amount, charge_percentage,
        status, reason, order_status_at_cancel, initiated_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
      RETURNING id`,
      [
        orderId,
        order.user_id,
        order.advance_payment_id || 'none',
        razorpayRefund?.id || null,
        advanceAmount,
        refundDetails.cancellationCharge,
        refundDetails.refundAmount,
        refundDetails.chargePercentage,
        refundStatus,
        reason,
        order.status,
        refundStatus === 'completed' ? new Date() : null,
      ]
    );

    const refundId = refundRes.rows[0].id;

    // Update order status
    await client.query(
      `UPDATE orders 
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = $2,
           cancellation_reason = $3,
           refund_status = $4,
           refund_amount = $5,
           cancellation_charge = $6,
           refund_id = $7,
           refund_initiated_at = NOW(),
           refund_completed_at = $8
       WHERE id = $1`,
      [
        orderId,
        cancelled_by,
        reason,
        refundStatus,
        refundDetails.refundAmount,
        refundDetails.cancellationCharge,
        razorpayRefund?.id || `manual_${refundId}`,
        refundStatus === 'completed' ? new Date() : null,
      ]
    );

    // If technician was assigned, notify them
    const techRes = await client.query(
      `SELECT t.id, t.push_token, t.full_name
       FROM order_technicians ot
       JOIN technicians t ON t.id = ot.technician_id
       WHERE ot.order_id = $1`,
      [orderId]
    );

    await client.query("COMMIT");

    // Log the cancellation
    console.log(`✅ Order ${orderId} cancelled successfully`);
    console.log(`   Status at cancel: ${order.status}`);
    console.log(`   Advance amount: ₹${advanceAmount}`);
    console.log(`   Cancellation charge: ₹${refundDetails.cancellationCharge} (${refundDetails.chargePercentage}%)`);
    console.log(`   Refund amount: ₹${refundDetails.refundAmount}`);
    console.log(`   Refund status: ${refundStatus}`);
    console.log(`   Test payment: ${testPayment}`);

    // Send notification to technician if assigned (async)
    if (techRes.rows.length > 0) {
      console.log(`📱 Should notify technician ${techRes.rows[0].full_name} about cancellation`);
    }

    res.json({
      success: true,
      message: refundStatus === 'completed' 
        ? "Order cancelled and refund processed" 
        : "Order cancelled. Refund is being processed.",
      refund: {
        id: refundId,
        razorpayRefundId: razorpayRefund?.id || null,
        advanceAmount,
        cancellationCharge: refundDetails.cancellationCharge,
        chargePercentage: refundDetails.chargePercentage,
        refundAmount: refundDetails.refundAmount,
        status: refundStatus,
        isTestPayment: testPayment,
        estimatedTime: refundStatus === 'completed' 
          ? "Instant" 
          : "3-5 business days",
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CANCEL ORDER ERROR:", err);
    res.status(500).json({ 
      error: "Failed to cancel order",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    client.release();
  }
});

/* =========================
   GET REFUND STATUS
========================= */
router.get("/status/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);

  try {
    const refundRes = await pool.query(
      `SELECT 
        r.*,
        o.status as order_status,
        o.cancelled_at,
        o.service_type,
        o.package_name
       FROM refunds r
       JOIN orders o ON o.id = r.order_id
       WHERE r.order_id = $1
       ORDER BY r.created_at DESC
       LIMIT 1`,
      [orderId]
    );

    if (!refundRes.rows.length) {
      return res.status(404).json({ error: "No refund found for this order" });
    }

    const refund = refundRes.rows[0];

    // If we have a Razorpay refund ID and status is processing, check latest status
    if (razorpay && refund.razorpay_refund_id && refund.status === 'processing') {
      try {
        const razorpayRefund = await razorpay.refunds.fetch(refund.razorpay_refund_id);
        
        if (razorpayRefund.status === 'processed') {
          // Update database
          await pool.query(
            `UPDATE refunds 
             SET status = 'completed', completed_at = NOW()
             WHERE id = $1`,
            [refund.id]
          );
          
          await pool.query(
            `UPDATE orders 
             SET refund_status = 'completed', refund_completed_at = NOW()
             WHERE id = $1`,
            [orderId]
          );
          
          refund.status = 'completed';
          refund.completed_at = new Date();
        } else if (razorpayRefund.status === 'failed') {
          await pool.query(
            `UPDATE refunds 
             SET status = 'failed', failed_at = NOW(), failure_reason = $2
             WHERE id = $1`,
            [refund.id, 'Payment provider refund failed']
          );
          
          refund.status = 'failed';
        }
      } catch (razorpayError) {
        console.error("Error fetching Razorpay refund status:", razorpayError.message);
      }
    }

    res.json({
      orderId,
      refundId: refund.id,
      razorpayRefundId: refund.razorpay_refund_id,
      advanceAmount: parseFloat(refund.advance_amount),
      cancellationCharge: parseFloat(refund.cancellation_charge),
      chargePercentage: parseFloat(refund.charge_percentage),
      refundAmount: parseFloat(refund.refund_amount),
      status: refund.status,
      reason: refund.reason,
      orderStatusAtCancel: refund.order_status_at_cancel,
      serviceType: refund.service_type,
      packageName: refund.package_name,
      initiatedAt: refund.initiated_at,
      completedAt: refund.completed_at,
      failedAt: refund.failed_at,
      failureReason: refund.failure_reason,
      cancelledAt: refund.cancelled_at,
    });

  } catch (err) {
    console.error("REFUND STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to get refund status" });
  }
});

/* =========================
   GET USER'S REFUND HISTORY
========================= */
router.get("/history/:firebase_uid", async (req, res) => {
  const { firebase_uid } = req.params;

  try {
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [firebase_uid]
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userRes.rows[0].id;

    const refundsRes = await pool.query(
      `SELECT 
        r.*,
        o.service_type,
        o.package_name,
        o.vehicle,
        o.cancelled_at
       FROM refunds r
       JOIN orders o ON o.id = r.order_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [userId]
    );

    res.json(refundsRes.rows);

  } catch (err) {
    console.error("REFUND HISTORY ERROR:", err);
    res.status(500).json({ error: "Failed to get refund history" });
  }
});

/* =========================
   RAZORPAY REFUND WEBHOOK
========================= */
router.post("/webhook/razorpay", async (req, res) => {
  const { event, payload } = req.body;

  try {
    console.log(`📥 Razorpay webhook received: ${event}`);

    if (event === 'refund.processed') {
      const refundData = payload.refund.entity;
      
      await pool.query(
        `UPDATE refunds 
         SET status = 'completed', 
             completed_at = NOW(),
             processed_at = NOW()
         WHERE razorpay_refund_id = $1`,
        [refundData.id]
      );

      const refundRes = await pool.query(
        `SELECT order_id FROM refunds WHERE razorpay_refund_id = $1`,
        [refundData.id]
      );

      if (refundRes.rows.length > 0) {
        await pool.query(
          `UPDATE orders 
           SET refund_status = 'completed', refund_completed_at = NOW()
           WHERE id = $1`,
          [refundRes.rows[0].order_id]
        );
      }

      console.log(`✅ Refund completed via webhook: ${refundData.id}`);
    }

    if (event === 'refund.failed') {
      const refundData = payload.refund.entity;
      
      await pool.query(
        `UPDATE refunds 
         SET status = 'failed', 
             failed_at = NOW(),
             failure_reason = $2
         WHERE razorpay_refund_id = $1`,
        [refundData.id, 'Refund failed at payment provider']
      );

      const refundRes = await pool.query(
        `SELECT order_id FROM refunds WHERE razorpay_refund_id = $1`,
        [refundData.id]
      );

      if (refundRes.rows.length > 0) {
        await pool.query(
          `UPDATE orders SET refund_status = 'failed' WHERE id = $1`,
          [refundRes.rows[0].order_id]
        );
      }

      console.log(`❌ Refund failed via webhook: ${refundData.id}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;