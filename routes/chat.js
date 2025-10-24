// routes/chat.js
import express from "express";
import admin from "firebase-admin";

const router = express.Router();

// ❌ ここで呼び出さない
// const db = admin.firestore();

// 会話履歴取得
router.get("/:uid/history", async (req, res) => {
  try {
    const db = admin.firestore(); // ✅ ハンドラー内で取得
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

    // 古い順に並び替え（Claude APIに渡すため）
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
    const db = admin.firestore(); // ✅ ハンドラー内で取得
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

export default router;
