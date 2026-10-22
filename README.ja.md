# Orca Webhook Bridge

[![test](https://github.com/rocketbase00/orca_webhook/actions/workflows/test.yml/badge.svg)](https://github.com/rocketbase00/orca_webhook/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | **日本語**

Mac 上の [Orca](https://www.onorca.dev/) が発行するエージェント（Claude Code・Codex など）の状態変化を、別PCで動く [Hermes Agent](https://github.com/NousResearch/hermes-agent) へ届けます。どちらかがスリープ・オフライン・再起動しても失いません。

Orca プラグインが対象の `agent.status.changed` をローカルの永続キューへ保存し、別プロセスの Sender が Tailnet 経由で HMAC 署名付き Webhook として送ります。Hermes 側の小さな受信サーバーが保存・重複排除・順序制御をしてから、必要なものだけを Hermes へ渡します。

> [!NOTE]
> 本プロジェクトは個人による非公式のもので、Stably AI（Orca）および Nous Research（Hermes Agent）とは関係ありません。Orca のプラグイン機構は **Experimental** で、Orca の版によって API が変わる可能性があります。

## 状態

v0.1.0 は[仕様書](docs/spec.ja.md)の Phase 1〜2（収集と片方向の署名付き配送 = 通知基盤）を実装しています。Hermes への転送はルールベースの絞り込みまでです。**Phase 4（承認付き操作）は未実装**で、`actions.enabled: true` は設定で拒否されます。

## 仕組み

```text
Mac                                                       Hermes 側PC
┌───────────────────────────────────────────┐            ┌──────────────────────────────────────┐
│ Orca ─agent.status.changed─▶ Collector     │            │ Bridge Ingress (ingress/)             │
│        (plugin/, Orca プラグインワーカー)   │            │  署名・送信元の検証                    │
│              │ 同期コミット                 │   HTTPS    │  永続 Inbox + 重複判定台帳             │
│              ▼                             │  Tailscale │  ストリーム単位の順序制御               │
│        outbox.sqlite3 ──▶ Sender (sender/) ─┼───────────▶│              │ 別ワーカー             │
│                   LaunchAgent・再送・署名・  │  HMAC V2   │              ▼                        │
│                   復帰検出                  │            │  Hermes Webhook ルート（任意）         │
│ owb (bin/) 管理CLI                          │            │                                      │
└───────────────────────────────────────────┘            └──────────────────────────────────────┘
```

- **保存してから ack。** Collector は Orca のイベントハンドラー内で SQLite（WAL、`synchronous=FULL`）にコミットしてから ack を返します。ネットワークは待ちません。
- **at-least-once と重複排除。** 再送では毎回、同じ `event_id`・同じ本文バイト列を新しい署名で送ります。受信側は `(device_id, epoch, event_id)` と本文ハッシュで重複排除し、ID の競合は 409 で隔離します。
- **ストリーム単位で順序どおり。** 送信中は1ストリームにつき1件だけです。受信側は古い番号で現在の状態を巻き戻さず、欠番は記録します。
- **スリープ・オフラインに対応。** 受信側に届かない間は、バックオフしながら1件ずつ到達を確認します。オフライン中は試行回数に数えません。復帰・ネットワーク変化・到達回復を検出したら、待っていたイベントをすぐ送り直します。
- **黙って捨てない。** キューが満杯になったら収集を止めて障害を表示します。30日を超えた未達は Dead Letter として利用者の判断を待ちます。古い署名は再利用しません。

## ディレクトリ構成

| パス | 内容 |
| --- | --- |
| [`plugin/`](plugin) | **Orca プラグイン本体（Collector）**。このフォルダを Orca にインストールします。検証・範囲判定・保存だけを行い、ネットワークには触れません。 |
| [`plugin/lib/`](plugin/lib) | 共通部品（設定検証、エンベロープ、SQLite Outbox、HMAC V2 署名）。 |
| [`sender/`](sender) | LaunchAgent で動く Sender（リース、再送、到達確認、dry-run、ハートビート）。 |
| [`ingress/`](ingress) | 受信側PCで動く Bridge Ingress。 |
| [`bin/owb.mjs`](bin/owb.mjs) | 管理CLI `owb`。 |
| [`lib/`](lib) | Sender・Ingress・CLI 用の補助（シークレット参照、HTTP、ログ、launchd plist）。 |
| [`examples/`](examples) | Mac の設定、Ingress の設定、Hermes ルートの例。 |
| [`docs/spec.ja.md`](docs/spec.ja.md) | 設計仕様書（[English](docs/spec.md)）。 |

npm の依存パッケージはありません（`node:sqlite` などの Node 組み込み機能のみ）。

## 動作要件

- macOS、Orca **1.4.232 以降**（*Settings → Plugins* でプラグインシステムを有効化）
- Sender・CLI・Ingress には **Node.js 24 以上**（`node:sqlite` を使用）。Collector は Orca 内蔵の Node で動くので追加は不要です。
- Mac から Hermes 側PCへの経路（[Tailscale](https://tailscale.com/) など）

## Mac 側のセットアップ

```sh
git clone https://github.com/rocketbase00/orca_webhook.git
cd orca_webhook
alias owb="node $PWD/bin/owb.mjs"

# 1. 設定と Outbox を作成（無効・dry-run・収集対象なしの状態で始まる）
owb init --device-id macbook-air-01 \
  --endpoint-url https://<hermes-host>.<tailnet>.ts.net/bridge/v1/events
#    表示される epoch を控えておく（受信側の sources[].epochs に登録する）

# 2. 署名鍵をログインキーチェーンに生成し、受信側へ渡す用にファイルへ書き出す
owb secret generate --out ./bridge-key.txt   # 0600。受信側へ渡したら削除する
owb secret check                             # 指紋を表示（受信側と照合する）

# 3. Sender を LaunchAgent として登録（ログイン時に起動、異常終了時は再起動）
owb launchagent install
```

4. **Orca にプラグインをインストール**: *Settings → Plugins* でプラグインシステムを ON にし、*Install plugin* → *Local folder* にクローンした `plugin/` フォルダの絶対パスを入力します。要求する能力（`events:subscribe`、`notifications:show`）を確認して有効化・同意してください。Orca はフォルダをコピーするので、`plugin/` を更新したら再インストールが必要です。

5. **収集対象を決める**（空なら何も収集しません）:

   ```sh
   owb enable                      # config.enabled = true（まだ dry-run）
   # Orca で Claude Code / Codex を動かす
   owb targets                     # これまでに観測した worktreeId / paneKey（ローカル記録のみで送信しない）
   owb scope add --pane <paneKey>  # または --worktree <worktreeId>
   owb status
   ```

6. **dry-run を確認して本番へ**: `owb attempts` に `would POST ... signature ok` が出ることを確認してから `owb mode live` に切り替えます。dry-run 中に保存したイベントは、`owb requeue --dry-run-events` を実行しない限り送信されません。

Orca のコマンドパレットからも *Webhook Bridge: Show Status / Stop Bridge / Resume Bridge / Queue Test Event* を実行できます。

## Hermes 側PCのセットアップ

```sh
git clone https://github.com/rocketbase00/orca_webhook.git && cd orca_webhook   # Node.js 24+
mkdir -p ~/.config/orca-webhook-bridge && chmod 700 ~/.config/orca-webhook-bridge
install -m 600 bridge-key.txt ~/.config/orca-webhook-bridge/bridge-key-01.txt && rm bridge-key.txt
cp examples/ingress.config.example.json ~/.config/orca-webhook-bridge/ingress.config.json
#   keys[].secretRef、sources[].deviceId / epochs、dataDir を編集
node ingress/main.mjs check-config   # 鍵の指紋が Mac の `owb secret check` と一致することを確認
node ingress/main.mjs serve          # 127.0.0.1:8645 で待ち受け（systemd などで常駐させる）
```

- 既定では `127.0.0.1` で待ち受けます。Tailnet から HTTPS で受けるには、`tailscale serve`（または別のリバースプロキシ）で `http://127.0.0.1:8645` へ中継するか、`tls.certFile` / `tls.keyFile` を設定して Tailscale のアドレスに bind してください。`0.0.0.0` への bind は `allowWildcardBind: true` を明示しない限り拒否します。
- 接続元アドレスは `allowedSourceCidrs` で制限します。既定ではループバックと Tailscale の範囲を許可します。
- Hermes に渡す場合は `processing.forward` を有効にし、[`examples/hermes-route.example.yaml`](examples/hermes-route.example.yaml) を参考に Webhook ルートを作ります。転送されるのは、選んだ状態（既定 `waiting` と `done`）の最新の観測と収集障害だけで、状態は変わったときだけ転送します。Orca は同じ状態を繰り返し発行することがあります（数分後にもう一度 `done` など）が、その繰り返しは保存だけして転送しません。各イベントには `historical`（既定で観測から600秒超）と欠番のフラグが付きます。鍵は Mac → Ingress とは別のものを使ってください。
- `node ingress/main.mjs status` で送信元・ストリーム・Inbox を確認できます。到達性はハートビートをもとに `up` か `unknown` で表示し、欠落を「スリープ中」とは表示しません。

## 運用

```sh
owb status              # 収集・送信・キュー・配送先・収集障害
owb stop / owb start    # Bridge全体停止（収集＋新規送信、キュー保持）/ 再開
owb collector disable   # 収集だけ止める（キュー済みの送信は継続）
owb sender pause        # 送信だけ止める（収集は継続）
owb events --status dead_letter
owb show <eventId>      # 保存済み本文と試行履歴
owb requeue <eventId> | --dead-letters
owb discard <eventId>   # 削除できるのは Dead Letter / dry-run のみ
owb link <streamId> <linearIssueId> DEV-123   # Linear Issue の明示的な関連付け
owb endpoint confirm    # 配送先URL変更の承認（承認するまで既存イベントは送らない）
```

Sender のログは `~/Library/Application Support/OrcaWebhookBridge/logs/sender.log` に出力され、5MB ごとに3世代までローテーションします。Collector のログは Orca のプラグインログに出ます。

**署名鍵のローテーション**（仕様 §10.3）: `owb secret generate` は既存の鍵を上書きしません。まず `config.json` の `sender.signing.keyId` と `secretRef` を新しい値に変えて、新しい鍵を生成します。次に Ingress の `keys` に新しい鍵を追加し、`sources[].keyIds` で新旧の両方を許可します。配送できることを確認したら、旧鍵を `enabled: false` にします。イベントIDと本文は変わりません。

## 設定

`owb init` が `~/Library/Application Support/OrcaWebhookBridge/config.json` を作成します（例: [`examples/config.example.json`](examples/config.example.json)）。設定は全体を検証してから反映し、次のものは拒否します。

- 未知のキーと、秘密の直書き（`secretRef` による参照だけを許可）
- `includeTranscript: true` と `actions.enabled: true`
- リダイレクトの追従
- HTTPS 以外の宛先（ループバックを除く）
- `sender.allowedHosts` に含まれないホスト

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `enabled` / `mode` | `false` / `dry_run` | 全体スイッチ。`dry_run` は POST 以外のすべてを行います。 |
| `collector.scope` | 空 | 収集する Worktree ID / paneKey。空なら何も収集しません。 |
| `sender.endpointUrl`, `allowedHosts` | — | 受信側URLと、許可するホストの一覧。 |
| `sender.signing.secretRef` | `keychain:orca-webhook-bridge/<endpointId>` | `keychain:<service>/<account>` または `file:/abs/path`（0600）。 |
| `sender.responseContract` | `bridge_v1` | `hermes_webhook` にすると、Ingress を介さず Hermes 内蔵ルートへ直接送ります。 |
| `queue.maxUndeliveredEvents` / `maxDiskBytes` | 100,000 / 256 MiB | 超えたら収集を止めて障害を記録します。削除はしません。 |
| `sender.retry.maxEventAgeDays` | 30 | これより古い未達は `expired` の Dead Letter になります。 |

## 送信されるデータ

既定で送るのは状態と識別子だけです（仕様 §18）。

| 送る | 送らない |
| --- | --- |
| `state` の原値と正規化値、直前の状態、`receivedAt` の原値、`mainAgent`（`state`・`outcome`・`stateStartedAt`）、`worktreeId`、`paneKey`、明示設定した provider / Linear Issue、端末ID、epoch、ストリーム番号 | プロンプト、回答本文、ターミナル出力、環境変数、APIキー、通知本文 |

`worktreeId` と `paneKey` は Orca が報告した値のまま送ります。自分の環境で中身に何が含まれるかは `owb targets` で確認してください。

## 保証の範囲と制約

- イベントが保存済みになるのは Outbox へのコミット後だけです（仕様 §8.3）。次の場合は保証の対象外です: Orca が配信しなかったイベント、コミット前のクラッシュ、Bridge の停止中やペインが収集対象外だった期間。その場合、次のイベントの `previous_state` は `null` になり、受信側には欠番として記録されます。
- `done` は「終了として観測された」ことだけを示し、作業の成功や Issue の完了を意味しません。Bridge は Linear を更新しません。
- Orca には現在の状態を読み取る API がないため、Collector は任意のタイミングで状態を取得できません。空白期間のあとは、受信側に最終観測時点の状態が表示されます。

## 開発

```sh
npm test   # node:test を使用。依存なし
```

テストは48件です。[`test/orca-runtime.test.mjs`](test/orca-runtime.test.mjs) は、インストール済みの `Orca.app` に同梱されたプラグインワーカー実行環境に `plugin/` を読み込みます。そのうえで Orca と同じホスト↔ワーカーのプロトコルで、イベント配信・コマンド実行・シャットダウンを行います。Orca がインストールされていない場合はスキップします。

| 受け入れ基準（仕様 §20） | 状態 |
| --- | --- |
| A01, A03〜A05, A07, A08, A13, A14, A16〜A19, A21〜A23, A25 | 自動テストで確認済み |
| A09〜A12 | 通信断・復帰検出・リース回収・受信側停止を擬似的に確認。実機でのスリープ・再起動は未確認 |
| A02, A06, A15, A20, A24, A32 | 実機・長時間運用・Keychain ロックなどでの確認が必要 |
| A26〜A31 | Phase 4 が未実装のため対象外 |

<details>
<summary>要検証事項（仕様 §21）の状況</summary>

| ID | 状況 |
| --- | --- |
| V01 | Orca 1.4.232（Electron 43.7.8）で開発。同梱のワーカー実行環境は公開ソースと一致。commit は未特定。 |
| V02 | 同梱のワーカー実行環境で、起動・イベント配信・コマンド・シャットダウンを確認済み。Orca の画面からの導入・同意・無効化と再有効化は未確認。 |
| V03 | 未確認。`receivedAt` は原値（`received_at_raw`）のまま保持し、日時には変換しない。 |
| V04 | 公開 API に provider やセッション ID がないため `null` を送る。必要なら手動で対応付ける（`owb provider`）。 |
| V05 | Orca 内蔵の Node 24.21 で `node:sqlite`（WAL・トランザクション）が動作することを確認。 |
| V06 | Orca はアイドル状態のワーカーを5分で回収するため、Sender は別プロセスにしている。 |
| V07 | LaunchAgent と Keychain（`security`）を実装。Keychain がロック中は送信を保留する。実機では未確認。 |
| V08 | Orca に現在の状態を読み取る API がないため、受信側では最終観測時点の状態を表示する。 |
| V09 | Hermes の Generic V2 署名（`<timestamp>.<body>` の HMAC-SHA256 hex）と、`X-Request-ID` による配送IDに合わせている。Python の `hmac` と結果が一致することをテストで確認。 |
| V10〜V14 | 未確認（Hermes の権限、Tailscale/SSH、操作 API、Orca パネルからの制御、Linear）。 |

</details>

コントリビューションを歓迎します。大きな変更は先に Issue で相談してください。セキュリティ上の問題は [SECURITY.md](SECURITY.md) の手順で非公開に報告してください。

## ライセンス

[MIT](LICENSE)
