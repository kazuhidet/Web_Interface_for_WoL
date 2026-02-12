# WoL VLAN WebApp (Node.js)

Linuxサーバー上で動作する Wake on LAN (WoL) のWebアプリです。

- **Controller**: ブラウザUIでホスト(名前+MAC)登録/削除/編集、Agent登録、WoL実行
- **Agent**: VLAN内でWoL送信する小さなHTTPサービス（VLAN越え対策）

> **要件**: Node.js **18以上**（fetchを使用）

## 1) インストール

```bash
npm install
```

## 2) 起動

### Controller（中央Web）
```bash
MODE=controller HOST=0.0.0.0 PORT=3000 node server.js
```

ブラウザ:
`http://<controllerのIP>:3000`

### Agent（各VLAN内）
```bash
MODE=agent HOST=0.0.0.0 PORT=3001 AGENT_TOKEN='長いランダム文字列' node server.js
```

ヘルスチェック:
`http://<agentのIP>:3001/health`

## 3) 使い方（VLAN越え）

1. 各VLANにAgentを1台立てる（Raspberry Pi / 小型LinuxなどでもOK）
2. ControllerのUIからAgentを追加（URLとToken）
3. ホスト追加時に「どのAgent経由で起動するか」を選ぶ
4. 起動ボタンで WoL 送信

## 4) データ保存

Controllerは `storage.json` に hosts / agents を保存します（自動作成）。
Agentは保存しません。

## 5) セキュリティメモ

- Controllerは社内LANでも **認証（Basic認証やIP制限）** の追加を推奨
- AgentのTokenは十分長いランダム値にしてください
