const express = require('express');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Database setup
const db = new sqlite3.Database('./data.db');

// Create tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS server_configs (
    server_id TEXT PRIMARY KEY,
    rcon_ip TEXT,
    rcon_port INTEGER,
    rcon_password TEXT,
    subscription_id TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    trial_end_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id TEXT PRIMARY KEY,
    server_id TEXT,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// PayPal webhook endpoint
app.post('/webhook/paypal', async (req, res) => {
  try {
    console.log('Received PayPal webhook:', req.body.event_type);
    
    // Verify webhook signature (you'll add this later)
    // const signature = req.headers['paypal-transmission-sig'];
    // const timestamp = req.headers['paypal-transmission-time'];
    // const webhookId = req.headers['paypal-transmission-id'];
    
    const event = req.body;
    
    switch (event.event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await handleSubscriptionActivated(event);
        break;
        
      case 'BILLING.SUBSCRIPTION.CANCELLED':
        await handleSubscriptionCancelled(event);
        break;
        
      case 'PAYMENT.SALE.COMPLETED':
        await handlePaymentCompleted(event);
        break;
        
      case 'PAYMENT.SALE.DENIED':
        await handlePaymentDenied(event);
        break;
        
      default:
        console.log('Unhandled event type:', event.event_type);
    }
    
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Handle subscription activation
async function handleSubscriptionActivated(event) {
  const subscriptionId = event.resource.id;
  const status = event.resource.status;
  
  console.log(`Subscription ${subscriptionId} activated with status: ${status}`);
  
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO subscriptions (subscription_id, status, updated_at) 
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [subscriptionId, status],
      (err) => {
        if (err) {
          console.error('Error updating subscription:', err);
          reject(err);
        } else {
          console.log(`Subscription ${subscriptionId} activated successfully`);
          resolve();
        }
      }
    );
  });
}

// Handle subscription cancellation
async function handleSubscriptionCancelled(event) {
  const subscriptionId = event.resource.id;
  const status = event.resource.status;
  
  console.log(`Subscription ${subscriptionId} cancelled with status: ${status}`);
  
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE subscription_id = ?`,
      [status, subscriptionId],
      (err) => {
        if (err) {
          console.error('Error updating subscription:', err);
          reject(err);
        } else {
          console.log(`Subscription ${subscriptionId} cancelled successfully`);
          resolve();
        }
      }
    );
  });
}

// Handle payment completion
async function handlePaymentCompleted(event) {
  const subscriptionId = event.resource.billing_agreement_id;
  const amount = event.resource.amount.total;
  const currency = event.resource.amount.currency;
  
  console.log(`Payment completed for subscription ${subscriptionId}: ${amount} ${currency}`);
  
  // Update subscription status to active
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE subscriptions SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE subscription_id = ?`,
      [subscriptionId],
      (err) => {
        if (err) {
          console.error('Error updating payment:', err);
          reject(err);
        } else {
          console.log(`Payment for subscription ${subscriptionId} processed successfully`);
          resolve();
        }
      }
    );
  });
}

// Handle payment denial
async function handlePaymentDenied(event) {
  const subscriptionId = event.resource.billing_agreement_id;
  
  console.log(`Payment denied for subscription ${subscriptionId}`);
  
  // Update subscription status to inactive
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE subscriptions SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP WHERE subscription_id = ?`,
      [subscriptionId],
      (err) => {
        if (err) {
          console.error('Error updating denied payment:', err);
          reject(err);
        } else {
          console.log(`Payment denial for subscription ${subscriptionId} processed successfully`);
          resolve();
        }
      }
    );
  });
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Zentro Webhook Server Running',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Zentro webhook server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook/paypal`);
});

module.exports = app; 