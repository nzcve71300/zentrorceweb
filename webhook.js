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
    guild_id TEXT,
    rcon_ip TEXT,
    rcon_port INTEGER,
    rcon_password TEXT,
    subscription_id TEXT,
    subscription_plan TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    subscription_end_date INTEGER,
    is_active INTEGER DEFAULT 0,
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

  db.run(`CREATE TABLE IF NOT EXISTS rust_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    admin_id TEXT,
    server_name TEXT,
    rcon_ip TEXT,
    rcon_port INTEGER,
    rcon_password TEXT
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
        
      case 'BILLING.SUBSCRIPTION.UPDATED':
        await handleSubscriptionUpdated(event);
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

// Handle subscription updates (upgrades/downgrades)
async function handleSubscriptionUpdated(event) {
  const subscriptionId = event.resource.id;
  const planId = event.resource.plan_id;
  const status = event.resource.status;
  
  console.log(`Subscription ${subscriptionId} updated - Plan: ${planId}, Status: ${status}`);
  
  // Get the new plan limit based on plan_id
  const planLimits = {
    'P-1SERVER': 1,
    'P-5SERVERS': 5,
    'P-10SERVERS': 10
  };
  
  const newLimit = planLimits[planId] || 1;
  console.log(`New plan limit: ${newLimit} servers`);
  
  return new Promise((resolve, reject) => {
    // Update subscription in database
    db.run(
      `UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE subscription_id = ?`,
      [status, subscriptionId],
      (err) => {
        if (err) {
          console.error('Error updating subscription:', err);
          reject(err);
        } else {
          console.log(`Subscription ${subscriptionId} updated successfully`);
          
          // Find guild_id for this subscription and handle downgrade
          db.get('SELECT guild_id FROM server_configs WHERE subscription_id = ?', [subscriptionId], (err, config) => {
            if (err || !config) {
              console.error('No server config found for subscription:', subscriptionId);
              resolve();
              return;
            }
            
            // Handle automatic downgrade if needed
            handleSubscriptionDowngrade(config.guild_id, newLimit);
            resolve();
          });
        }
      }
    );
  });
}

// Handle automatic subscription downgrades
function handleSubscriptionDowngrade(guildId, newLimit) {
  console.log(`Checking for downgrade: Guild ${guildId}, new limit: ${newLimit}`);
  
  // Get current server count for this guild
  db.get('SELECT COUNT(*) as count FROM rust_servers WHERE guild_id = ?', [guildId], (err, result) => {
    if (err) {
      console.error('Failed to get server count:', err);
      return;
    }
    
    const currentCount = result.count;
    console.log(`Current server count: ${currentCount}, New limit: ${newLimit}`);
    
    if (currentCount > newLimit) {
      console.log(`Downgrade detected! Removing ${currentCount - newLimit} excess servers`);
      
      // Get servers to remove (oldest first)
      db.all('SELECT * FROM rust_servers WHERE guild_id = ? ORDER BY id ASC LIMIT ?', 
        [guildId, currentCount - newLimit], (err, serversToRemove) => {
        if (err) {
          console.error('Failed to get servers to remove:', err);
          return;
        }
        
        // Remove excess servers
        serversToRemove.forEach(server => {
          db.run('DELETE FROM rust_servers WHERE id = ?', [server.id], (err) => {
            if (err) {
              console.error(`Failed to remove server ${server.server_name}:`, err);
            } else {
              console.log(`Removed server: ${server.server_name} (ID: ${server.id}) due to downgrade`);
            }
          });
        });
        
        // Send notification about downgrade
        sendDowngradeNotification(guildId, newLimit, serversToRemove.length);
      });
    } else {
      console.log('No downgrade needed - server count is within limits');
    }
  });
}

// Send downgrade notification
function sendDowngradeNotification(guildId, newLimit, removedCount) {
  console.log(`Downgrade notification: Guild ${guildId}, new limit: ${newLimit}, removed: ${removedCount} servers`);
  
  // This would send a Discord notification about the downgrade
  // You can implement this using your Discord bot client
  // Example:
  // const { EmbedBuilder } = require('discord.js');
  // const embed = new EmbedBuilder()
  //   .setColor('#ff7f00')
  //   .setTitle('Subscription Downgrade')
  //   .setDescription(`Your subscription has been updated. You can now have up to ${newLimit} servers.\n\n${removedCount} excess servers have been automatically removed.`);
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
    timestamp: new Date().toISOString(),
    features: [
      'PayPal webhook processing',
      'Automatic subscription management',
      'Server limit enforcement',
      'Downgrade handling'
    ]
  });
});

// Start server
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Zentro webhook server running on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook/paypal`);
    console.log(`Health check: http://localhost:${PORT}/`);
  });
}

module.exports = app; 