// routes/chat.js
import express from "express";
import admin from "firebase-admin";

const router = express.Router();

// 会話履歴取得
router.get("/:uid/history", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const limit = parseInt(req.query.limit) || 10;

    console.log(`📖 Fetching history for user: ${uid}, limit: ${limit}`);

    const messagesRef = db
      .collection("conversations")
      .doc(uid)
      .collection("messages")
      .orderBy("timestamp", "desc")
      .limit(limit);

    const snapshot = await messagesRef.get();

    if (snapshot.empty) {
      console.log(`ℹ️ No history found for user: ${uid}`);
      return res.json({ messages: [] });
    }

    const messages = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      messages.push({
        id: doc.id,
        role: data.role,
        content: data.content,
        timestamp: data.timestamp?.toDate
          ? data.timestamp.toDate().toISOString()
          : null,
        message_id: data.message_id || null,
      });
    });

    messages.reverse();

    console.log(`✅ Found ${messages.length} messages for user: ${uid}`);
    res.json({ messages });
  } catch (error) {
    console.error("❌ Error fetching history:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// メッセージ保存
router.post("/:uid/message", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const { role, content, message_id } = req.body;

    if (!role || !content) {
      return res.status(400).json({ error: "missing_required_fields" });
    }

    if (!["user", "assistant"].includes(role)) {
      return res.status(400).json({ error: "invalid_role" });
    }

    console.log(`💾 Saving message for user: ${uid}, role: ${role}`);

    const messageData = {
      role,
      content,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (message_id) {
      messageData.message_id = message_id;
    }

    const docRef = await db
      .collection("conversations")
      .doc(uid)
      .collection("messages")
      .add(messageData);

    console.log(`✅ Message saved: ${docRef.id}`);
    res.json({
      success: true,
      id: docRef.id,
    });
  } catch (error) {
    console.error("❌ Error saving message:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// プロフィール取得
router.get("/:uid/profile", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;

    console.log(`📖 Fetching profile for user: ${uid}`);

    const profileRef = db
      .collection("conversations")
      .doc(uid)
      .collection("profile")
      .doc("info");

    const profileDoc = await profileRef.get();

    if (!profileDoc.exists) {
      console.log(`ℹ️ No profile found for user: ${uid}`);
      return res.json({ exists: false, profile: null });
    }

    const profileData = profileDoc.data();

    console.log(`✅ Profile found for user: ${uid}`);
    res.json({
      exists: true,
      profile: {
        ...profileData,
        created_at: profileData.created_at?.toDate
          ? profileData.created_at.toDate().toISOString()
          : null,
        updated_at: profileData.updated_at?.toDate
          ? profileData.updated_at.toDate().toISOString()
          : null,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching profile:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// プロフィール保存
router.post("/:uid/profile", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const profileData = req.body;

    console.log(`💾 Saving profile for user: ${uid}`);

    const profileRef = db
      .collection("conversations")
      .doc(uid)
      .collection("profile")
      .doc("info");

    const data = {
      ...profileData,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    const existingProfile = await profileRef.get();
    if (!existingProfile.exists) {
      data.created_at = admin.firestore.FieldValue.serverTimestamp();
    }

    await profileRef.set(data, { merge: true });

    console.log(`✅ Profile saved for user: ${uid}`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error saving profile:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});
// 会員種別取得
router.get("/:uid/membership", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;

    console.log(`👤 Fetching membership for user: ${uid}`);

    const membershipRef = db
      .collection("conversations")
      .doc(uid)
      .collection("membership")
      .doc("info");

    const membershipDoc = await membershipRef.get();

    if (!membershipDoc.exists) {
      console.log(`ℹ️ No membership found, defaulting to free tier`);
      return res.json({ 
        exists: false, 
        tier: "free" // デフォルトは一般会員
      });
    }

    const membershipData = membershipDoc.data();

    console.log(`✅ Membership found: ${membershipData.tier}`);
    res.json({
      exists: true,
      tier: membershipData.tier,
      created_at: membershipData.created_at?.toDate
        ? membershipData.created_at.toDate().toISOString()
        : null,
      updated_at: membershipData.updated_at?.toDate
        ? membershipData.updated_at.toDate().toISOString()
        : null,
    });
  } catch (error) {
    console.error("❌ Error fetching membership:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// 会員種別更新
router.post("/:uid/membership", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const { tier } = req.body;

    if (!["free", "premium"].includes(tier)) {
      return res.status(400).json({ error: "invalid_tier" });
    }

    console.log(`💳 Updating membership for user: ${uid} to ${tier}`);

    const membershipRef = db
      .collection("conversations")
      .doc(uid)
      .collection("membership")
      .doc("info");

    const data = {
      tier,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    const existingMembership = await membershipRef.get();
    if (!existingMembership.exists) {
      data.created_at = admin.firestore.FieldValue.serverTimestamp();
    }

    await membershipRef.set(data, { merge: true });

    console.log(`✅ Membership updated to ${tier}`);
    res.json({ success: true, tier });
  } catch (error) {
    console.error("❌ Error updating membership:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

export default router;
