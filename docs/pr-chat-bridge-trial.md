# pr-chat-bridge 実地試験の記録

pr-chat-bridge skill (ippoan/claude-skills#102) の end-to-end 試験用 PR。
CCoW セッションが投稿する検証依頼コメント → user が chat 起動リンクをクリック →
chat 側 Claude が Claude in Chrome で preview を検証 → 結果コメントで CCoW が起床、
のループを確認する。

- 検証対象: https://dtako-preview.ippoan.org (branch push で自動 deploy)
- 経緯・調査: ohishi-exp/nuxt-dtako-admin#196
- この PR は draft のまま検証し、成立確認後に close または ready 判断する
