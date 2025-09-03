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

/* -------------------- 小ヘルパー -------------------- */
const tsFromSec = (sec) =>
  sec ? admin.firestore.Timestamp.fromDate(new Date(sec * 1000)) : null;

async function resolveUserIdFromCustomerId(customerId) {
  if (!customerId) return null;
  const snap = await db
    .collection("users")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function resolveUserIdFromSub(sub) {
  if (!sub) return null;
  if (sub.metadata?.userId) return sub.metadata.userId;
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  return await resolveUserIdFromCustomerId(customerId);
}

async function resolveUserIdFromInvoice(inv) {
  if (!inv) return null;
  if (inv.metadata?.userId) return inv.metadata.userId;

  // subscription → metadata → customer の順で解決
  let sub = inv.subscription;
  if (typeof sub === "string") {
    try {
      sub = await stripe.subscriptions.retrieve(sub);
    } catch (_) {
      sub = null;
    }
  }
  if (sub?.metadata?.userId) return sub.metadata.userId;

  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
  return await resolveUserIdFromCustomerId(customerId);
}

/* -------------------- Webhook (raw) -------------------- */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    // Stripe以外（署名ヘッダのないアクセス）は静かに無視
    if (!sig) {
      console.log("🤷 署名なしの非Stripeアクセスを無視（/webhook）");
      return res.status(200).end();
    }

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
      // ② イベントごとの処理
      switch (event.type) {
        /* 解約予約/更新などの変更 */
        case "customer.subscription.updated": {
          const sub = event.data.object; // Stripe.Subscription
          const userId = await resolveUserIdFromSub(sub);
          const willCancel = !!sub.cancel_at_period_end || !!sub.cancel_at;
          const cancelAtSec = sub.cancel_at || sub.current_period_end || null;

          if (userId) {
            await db
              .collection("users")
              .doc(userId)
              .set(
                {
                  cancelPending: willCancel || null,
                  cancelAt: tsFromSec(cancelAtSec),
                  ...(sub.current_period_end
                    ? { premiumUntil: tsFromSec(sub.current_period_end) }
                    : {}),
                },
                { merge: true }
              );
          } else {
            console.warn(
              "subscription.updated: userId not resolved (sub:",
              sub.id,
              ")"
            );
          }
          console.log(
            `📝 subscription.updated: ${sub.id}, willCancel=${willCancel}, userId=${
              userId || "N/A"
            }`
          );
          break;
        }

        /* チェックアウト完了（初回課金） */
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.userId;

          if (userId) {
            const customerId =
              typeof session.customer === "string"
                ? session.customer
                : session.customer?.id || null;
            const subscriptionId =
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id || null;

            // 初回サイクルの次回更新日時を取得
            let premiumUntilTs = null;
            try {
              if (session.mode === "subscription" && session.subscription) {
                const sub =
                  typeof session.subscription === "string"
                    ? await stripe.subscriptions.retrieve(session.subscription)
                    : session.subscription;
                if (sub?.current_period_end) {
                  premiumUntilTs = tsFromSec(sub.current_period_end);
                }
              }
            } catch (e) {
              console.warn("⚠️ subscription取得に失敗:", e.message);
            }

            await db
              .collection("users")
              .doc(userId)
              .set(
                {
                  premium: true,
                  premiumSince:
                    admin.firestore.FieldValue.serverTimestamp(),
                  ...(premiumUntilTs ? { premiumUntil: premiumUntilTs } : {}),
                  ...(customerId ? { stripeCustomerId: customerId } : {}),
                  ...(subscriptionId ? { lastSubscriptionId: subscriptionId } : {}),
                  // 初回は解約予約なしで初期化
                  cancelPending: null,
                  cancelAt: null,
                },
                { merge: true }
              );
            console.log(`🎉 Premium付与: ${userId} (session ${session.id})`);
          } else {
            console.log("ℹ️ userIdがmetadataにありません");
          }
          break;
        }

        /* 継続課金成功（月次） */
        case "invoice.payment_succeeded": {
          const inv = event.data.object; // Stripe.Invoice
          const userId = await resolveUserIdFromInvoice(inv);

          // 次回更新日の候補（lines[0].period.end が最優先）
          const periodEndSec =
            inv?.lines?.data?.[0]?.period?.end ||
            inv?.period_end ||
            null;

          if (userId && periodEndSec) {
            await db
              .collection("users")
              .doc(userId)
              .set(
                { premium: true, premiumUntil: tsFromSec(periodEndSec) },
                { merge: true }
              );
          }
          console.log(
            `✅ 継続課金成功: invoice ${inv.id}, amount=${inv.amount_paid}, userId=${
              userId || "N/A"
            }, next=${periodEndSec || "N/A"}`
          );
          break;
        }

        case "payment_intent.succeeded": {
          const pi = event.data.object;
          console.log(`💰 PaymentIntent成功: ${pi.id}, amount=${pi.amount}`);
          break;
        }

        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const reason = pi.last_payment_error?.message || "unknown";
          console.log(`❌ PaymentIntent失敗: ${pi.id}, reason=${reason}`);
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          console.log(
            `❌ 請求失敗: invoice ${invoice.id}, customer=${invoice.customer}`
          );
          break;
        }

        case "checkout.session.expired": {
          const s = event.data.object;
          console.log(`⌛ Checkout期限切れ: ${s.id}`);
          break;
        }

        /* 解約（期末到達）→ premium を落とす */
        case "customer.subscription.deleted": {
          const sub = event.data.object; // Stripe.Subscription
          const userId = await resolveUserIdFromSub(sub);

          console.log(
            `👋 退会: subscription ${sub.id}, userId=${userId || "N/A"}`
          );

          if (userId) {
            await db
              .collection("users")
              .doc(userId)
              .set(
                {
                  premium: false,
                  premiumUntil: null,
                  cancelPending: null,
                  cancelAt: null,
                },
                { merge: true }
              );
          } else {
            console.warn(
              "subscription.deleted: userId not resolved (sub:",
              sub.id,
              ")"
            );
          }
          break;
        }

        default: {
          console.log(`ℹ️ 未処理イベント: ${event.type}`);
          break;
        }
      }

      // ③ 処理済みマーク
      await seenRef.set({
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ received: true });
    } catch (err) {
      console.error("🛑 ハンドラ処理中エラー:", err);
      // 5xxを返すとStripeが自動リトライ
      return res.status(500).end();
    }
  }
);

/* -------------------- その他のルート -------------------- */
// 他のルートは raw の後で
app.use(express.json());
app.use(express.static("public"));

// APIルート（任意）
app.get("/api/hello", (_req, res) => {
  res.json({ message: "Hello from API" });
});

// Billing Portal を開く（解約・支払い情報の管理ができる）
app.get("/billing-portal", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).send("missing userId");

    const snap = await db.collection("users").doc(String(userId)).get();
    if (!snap.exists) return res.status(404).send("user not found");

    const { stripeCustomerId } = snap.data() || {};
    if (!stripeCustomerId) return res.status(400).send("customer not linked");

    const base = "https://www.oshaberiaiko.com";
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${base}/mypage.html?userId=${encodeURIComponent(userId)}`,
    });

    // そのままポータルへリダイレクト
    res.redirect(302, session.url);
  } catch (e) {
    console.error("Portal error:", e);
    res.status(500).send("portal_error");
  }
});

// ユーザー状態を返すAPI（マイページ用）
app.get("/api/user/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const snap = await db.collection("users").doc(id).get();
    if (!snap.exists) {
      return res.status(404).json({ exists: false });
    }
    const data = snap.data();

    const toISO = (v) =>
      v && typeof v.toDate === "function" ? v.toDate().toISOString() : v || null;

    res.json({
      exists: true,
      premium: !!data.premium,
      premiumSince: toISO(data.premiumSince),
      premiumUntil: toISO(data.premiumUntil),
      cancelPending: !!data.cancelPending,
      cancelAt: toISO(data.cancelAt),
    });
  } catch (e) {
    console.error("Get user error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// チェックアウト・セッション（テスト用）
app.post("/create-checkout-session", async (req, res) => {
  try {
    const userId = req.body.userId || "demo-user";
    const base = "https://www.oshaberiaiko.com";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", // 単発なら "payment"
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/success.html?userId=${encodeURIComponent(userId)}`,
      cancel_url: `${base}/cancel.html?userId=${encodeURIComponent(userId)}`,
      // セッションにも、作成される subscription にも userId を残す
      metadata: { userId },
      subscription_data: { metadata: { userId } },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Session error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`Server on :${port}`));
