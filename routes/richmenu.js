// routes/richmenu.js
import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";

const router = express.Router();

// リッチメニュー作成
router.post("/create", async (req, res) => {
  try {
    const { name, chatBarText, areas } = req.body;

    console.log(`🎨 リッチメニュー作成: ${name}`);

    const richMenuObject = {
      size: {
        width: 2500,
        height: 1686
      },
      selected: true,
      name: name,
      chatBarText: chatBarText || "メニュー",
      areas: areas
    };

    const response = await fetch("https://api.line.me/v2/bot/richmenu", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(richMenuObject)
    });

    const data = await response.json();

    if (data.richMenuId) {
      console.log(`✅ リッチメニュー作成成功: ${data.richMenuId}`);
      res.json({ success: true, richMenuId: data.richMenuId });
    } else {
      console.error("❌ リッチメニュー作成失敗:", data);
      res.status(400).json({ success: false, error: data });
    }
  } catch (error) {
    console.error("❌ エラー:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ユーザーにリッチメニューを割り当て
router.post("/link/:userId/:richMenuId", async (req, res) => {
  try {
    const { userId, richMenuId } = req.params;

    console.log(`🔗 リッチメニュー割り当て: ${userId} → ${richMenuId}`);

    const response = await fetch(
      `https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        }
      }
    );

    if (response.ok) {
      console.log(`✅ 割り当て成功`);
      res.json({ success: true });
    } else {
      const error = await response.json();
      console.error("❌ 割り当て失敗:", error);
      res.status(400).json({ success: false, error });
    }
  } catch (error) {
    console.error("❌ エラー:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 会員種別に応じてリッチメニューを切り替え
router.post("/switch/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { tier } = req.body;

    console.log(`🔄 リッチメニュー切り替え: ${userId} → ${tier}`);

    const richMenuId = tier === "premium"
      ? process.env.RICHMENU_PREMIUM_ID
      : process.env.RICHMENU_FREE_ID;

    if (!richMenuId) {
      return res.status(400).json({
        success: false,
        error: "リッチメニューIDが設定されていません"
      });
    }

    const response = await fetch(
      `https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        }
      }
    );

    if (response.ok) {
      console.log(`✅ 切り替え成功: ${tier}`);
      res.json({ success: true, tier, richMenuId });
    } else {
      const error = await response.json();
      console.error("❌ 切り替え失敗:", error);
      res.status(400).json({ success: false, error });
    }
  } catch (error) {
    console.error("❌ エラー:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
