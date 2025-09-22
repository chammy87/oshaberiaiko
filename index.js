// index.js
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import OpenAI from "openai";
import * as line from "@line/bot-sdk";
import admin from "firebase-admin";

import { system as aikoSystem, templates as aikoTemplates } from "./Prompt.js";

dotenv.config();

/* ======================== 初期化 ======================== */
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.Client({
  channelAccessToken: lineConfig.channelAccessToken,
});

/* ======================== 共通ユーティリティ ======================== */
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
  let sub = inv.subscription;
  if (typeof sub === "string") {
    try {
      sub = await stripe.subscriptions.retrieve(sub);
    } catch {
      sub = null;
    }
  }
  if (sub?.metadata?.userId) return sub.metadata.userId;
  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
  return await resolveUserIdFromCustomerId(customerId);
}

// JST の「本日」（無料回数カウント用キー）
function jstTodayKey() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
// Premium 判定
function isPremiumFromData(data) {
  if (!data) return false;
  const p = !!data.premium;
  const until = data.premiumUntil?.toDate ? data.premiumUntil.toDate() : null;
  if (!p) return false;
  if (!until) return true;
  return until.getTime() > Date.now();
}

/* ======================== 会話コア ======================== */
async function chatWithAiko({ userId, text }) {
  const userSnap = await db.collection("users").doc(String(userId)).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const premium = isPremiumFromData(userData);

  const dayKey = jstTodayKey();
  const usageRef = db.collection("usage_daily").doc(`${userId}_${dayKey}`);
  const LIMIT = 3; // 無料上限

  if (!premium) {
    const usageSnap = await usageRef.get();
    const used = usageSnap.exists ? usageSnap.data().count || 0 : 0;
    if (used >= LIMIT) {
      return {
        reply:
          "今日はもう3回おしゃべりしたから終了だよ🥲 また明日ね！\nもっと話したい人向けに「プレミアム」もあるよ✨",
        premium: false,
        limited: true,
      };
    }
  }

  const dangerWords = [
    "死にたい",
    "消えたい",
    "自殺",
    "傷つける",
    "虐待",
    "危ない",
    "首を",
    "窒息",
    "飛び降り",
    "殺す",
    "自傷",
  ];
  const safetyTriggered = dangerWords.some((w) => text.includes(w));

  const opener =
    aikoTemplates?.openers?.length && !safetyTriggered
      ? aikoTemplates.openers[
          Math.floor(Math.random() * aikoTemplates.openers.length)
        ]
      : null;

  const messages = [
    { role: "system", content: aikoSystem },
    ...(opener ? [{ role: "assistant", content: opener }] : []),
    { role: "user", content: text },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: premium ? 400 : 220,
    temperature: safetyTriggered ? 0.2 : 0.8,
  });
  const reply =
    completion.choices?.[0]?.message?.content?.trim() || "……";

  if (!premium) {
    await usageRef.set(
      {
        count: admin.firestore.FieldValue.increment(1),
        userId,
        dayKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return { reply, premium, limited: false };
}

/* ======================== Stripeイベント処理 ======================== */
async function handleStripeEvent(event) {
  switch (event.type) {
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const userId = await resolveUserIdFromSub(sub);
      const willCancel = !!sub.cancel_at_period_end || !!sub.cancel_at;
      const cancelAtSec = sub.cancel_at || sub.current_period_end || null;
      if (userId) {
        await db.collection("users").doc(userId).set(
          {
            cancelPending: willCancel || null,
            cancelAt: tsFromSec(cancelAtSec),
            ...(sub.current_period_end
              ? { premiumUntil: tsFromSec(sub.current_period_end) }
              : {}),
          },
          { merge: true }
        );
      }
      break;
    }
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

        let premiumUntilTs = null;
        try {
          if (session.mode === "subscription" && session.subscription) {
            const sub =
              typeof session.subscription === "string"
                ? await stripe.subscriptions.retrieve(session.subscription)
                : session.subscription;
            if (sub?.current_period_end)
              premiumUntilTs = tsFromSec(sub.current_period_end);
          }
        } catch (e) {
          console.warn("⚠️ subscription取得失敗:", e.message);
        }

        await db.collection("users").doc(userId).set(
          {
            premium: true,
            premiumSince: admin.firestore.FieldValue.serverTimestamp(),
            ...(premiumUntilTs ? { premiumUntil: premiumUntilTs } : {}),
            ...(customerId ? { stripeCustomerId: customerId } : {}),
            ...(subscriptionId ? { lastSubscriptionId: subscriptionId } : {}),
            cancelPending: null,
            cancelAt: null,
          },
          { merge: true }
        );
      }
      break;
    }
    case "invoice.payment_succeeded": {
      const inv = event.data.object;
      const userId = await resolveUserIdFromInvoice(inv);
      const periodEndSec =
        inv?.lines?.data?.[0]?.period?.end || inv?.period_end || null;
      if (userId && periodEndSec) {
        await db.collection("users").doc(userId).set(
          { premium: true, premiumUntil: tsFromSec(periodEndSec) },
          { merge: true }
        );
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const userId = await resolveUserIdFromSub(sub);
      if (userId) {
        await db.collection("users").doc(userId).set(
          {
            premium: false,
            premiumUntil: null,
            cancelPending: null,
            cancelAt: null,
          },
          { merge: true }
        );
      }
      break;
    }
    default:
      console.log(`ℹ️ 未処理イベント: ${event.type}`);
      break;
  }
}

/* ===========================================================
   🚨 重要：Stripe Webhook は express.json() よりも前に定義
   =========================================================== */

// 本番/ダッシュボードのWebhook
app.post("/webhook",
  // ★ 生ボディ（Buffer）で受ける。ここが署名検証の肝
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    // デバッグ用：本番では騒がしくならない程度に
    // console.log("sig exists?", !!sig, "isBuffer?", Buffer.isBuffer(req.body), "len", req.body?.length);
console.log("[WB] path=/webhook");
console.log("[WB] sig header exists:", !!req.headers["stripe-signature"]);
console.log("[WB] isBuffer:", Buffer.isBuffer(req.body), "len:", req.body?.length);
console.log("[WB] content-type:", req.headers["content-type"]);
    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, secret);
      // 先に受領OKを返す（Stripeの再送を防ぐ）
      res.status(200).send("ok");

      // 冪等制御（同じイベントIDは一度だけ処理）
      const seenRef = db.collection("stripe_events").doc(event.id);
      const seen = await seenRef.get();
      if (seen.exists) return;

      await handleStripeEvent(event);
      await seenRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
      console.error("❌ 本番Webhook署名エラー:", err.message);
      // 署名NGのときは 400 を返す
      if (!res.headersSent) res.status(400).send("bad signature");
    }
  }
);

// Stripe CLI専用のWebhook（listen→forward用）
app.post("/webhook-cli",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_CLI_WEBHOOK_SECRET;
    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, secret);
      res.status(200).send("ok");

      const seenRef = db.collection("stripe_events").doc(event.id);
      const seen = await seenRef.get();
      if (seen.exists) return;

      console.log("✅ CLI Webhook受信:", event.type);
      await handleStripeEvent(event);
      await seenRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
      console.error("❌ CLI署名検証エラー:", err.message);
      if (!res.headersSent) res.status(400).send("bad signature");
    }
  }
);

/* ======================== LINE Webhook ======================== */
// ※ LINEは独自の署名検証ミドルウェア。Stripeとは別ルートでOK
app.post("/line-webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(
      events.map(async (event) => {
        if (event.type === "message" && event.message?.type === "text") {
          const userId = event.source?.userId;
          const text = event.message.text || "";
          if (!userId || !text) return;
          const result = await chatWithAiko({ userId, text });
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text: result.reply,
          });
        }
      })
    );
    res.status(200).end();
  } catch (e) {
    console.error("LINE webhook error:", e);
    res.status(500).end();
  }
});

/* ======================== ここから通常ミドルウェア ======================== */
// ⬇️ これ以降に JSON パーサを置く（Stripeのraw受信と衝突しない）
app.use(express.json());
app.use(express.static("public"));

/* ======================== 通常ルート ======================== */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: process.env.GIT_COMMIT || "local" });
});

app.get("/api/hello", (_req, res) => {
  res.json({ message: "Hello from API" });
});

app.get("/", (_req, res) => res.send("OK"));

app.get("/billing-portal", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).send("missing userId");
    const snap = await db.collection("users").doc(String(userId)).get();
    if (!snap.exists) return res.status(404).send("user not found");
    const { stripeCustomerId } = snap.data() || {};
    if (!stripeCustomerId) return res.status(400).send("customer not linked");

    const base = process.env.PUBLIC_ORIGIN || "https://www.oshaberiaiko.com";
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${base}/mypage.html?userId=${encodeURIComponent(userId)}`,
    });
    res.redirect(302, session.url);
  } catch (e) {
    console.error("Portal error:", e);
    res.status(500).send("portal_error");
  }
});

app.get("/api/user/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const snap = await db.collection("users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ exists: false });
    const data = snap.data();
    const toISO = (v) =>
      v && typeof v.toDate === "function" ? v.toDate().toISOString() : v || null;
    res.json({
      exists: true,
      premium: isPremiumFromData(data),
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

app.post("/create-checkout-session", async (req, res) => {
  try {
    const userId = req.body.userId || "demo-user";
    const base = process.env.PUBLIC_ORIGIN || "https://www.oshaberiaiko.com";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/success.html?userId=${encodeURIComponent(userId)}`,
      cancel_url: `${base}/cancel.html?userId=${encodeURIComponent(userId)}`,
      metadata: { userId },
      subscription_data: { metadata: { userId } },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Session error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    if (!userId || !message)
      return res.status(400).json({ error: "missing userId or message" });
    const result = await chatWithAiko({ userId, text: message });
    if (result.limited) return res.status(429).json(result);
    return res.json(result);
  } catch (e) {
    console.error("Chat error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.listen(port, () => console.log(`Server on :${port}`));
