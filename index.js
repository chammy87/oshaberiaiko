import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
dotenv.config();

// === Firestore ===
import admin from "firebase-admin";
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8")
);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const app = express();
const port = process.env.PORT || 10000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// --- Stripe Webhook（rawで受信・一番上に置く）---
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
    console.log("✅ Webhook受信:", event.type);
  } catch (err) {
    console.error("❌ 署名検証エラー:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ① 重複実行防止（idempotency）
  const seenRef = db.collection("stripe_events").doc(event.id);
  const seen = await seenRef.get();
  if (seen.exists) {
    console.log("↩️ 既に処理済み:", event.id);
    return res.json({ received: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (userId) {
          await db.collection("users").doc(userId).set(
            { premium: true, premiumSince: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          console.log(`🎉 Premium付与: ${userId} (session ${session.id})`);
        } else {
          console.log("ℹ️ userIdがmetadataにありません");
        }
        break;
      }

      case "payment_intent.succeeded": {
        const pi = event.data.object;
        console.log(`💰 PaymentIntent成功: ${pi.id}, amount=${pi.amount}`);
        // ここに領収書送信・分析ログ等を追加してOK
        break;
      }

      // サブスク運用なら追加で有用：
      // case "invoice.payment_succeeded":
      // case "customer.subscription.deleted":
    }

    // ② イベントを処理済みにマーク
    await seenRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ received: true });
  } catch (err) {
    console.error("🛑 ハンドラ処理中エラー:", err);
    // 5xxを返すとStripeが自動リトライしてくれます
    res.status(500).end();
  }
});

// 他のルートは raw の後で
app.use(express.json());

app.use(express.static("public"));

// APIルート
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from API" });
});

// チェックアウト・セッション（テスト用）
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", // 単発なら "payment"
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
      metadata: { userId: req.body.userId || "demo-user" },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Session error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`Server on :${port}`));
