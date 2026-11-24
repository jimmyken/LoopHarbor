# LoopHarbor

**非同期・複数ターン対応のエージェントワークスペース** — Celery、Redis、LangGraph、PostgreSQL を使用。

[中文](README.md) | [English](README.en.md) | 日本語 | [Deutsch](README.de.md)

LoopHarbor は、次の仕組みを示す実行可能なエージェントのひな形です。

- FastAPI がリクエストを受け付け、すぐに `task_id` を返す。
- Redis が Celery のブローカーと結果バックエンドを提供する。
- Celery ワーカーがタスクをバックグラウンドで実行する。
- LangGraph がエージェントのノードを編成する。
- PostgreSQL がタスク状態と LangGraph のチェックポイントを保存する。
- クライアントが `task_id` でタスクの状態と結果を取得する。

エージェントはツール呼び出しに対応した OpenAI 互換 Chat Completions API を使い、複数ターンの質疑応答や契約書レビューを行います。モデルは四則演算とワーカーのローカル日時を取得するツールを呼び出してから回答できます。契約書レビューは参考情報であり、法的助言ではありません。

現在、Web UI、システムプロンプト、エラーメッセージ、記憶の要約は中国語です。翻訳されているのはドキュメントのみです。

## 1. 必要な環境

- Python 3.12（依存関係のインストールを検証済み。固定された psycopg バイナリパッケージは Python 3.14 に対応していません）
- Docker Desktop または Docker Engine
- Docker Compose

## 2. インフラの起動

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
docker compose up -d
```

`.env` が既にある場合は上書きせず、`.env.example` にある不足したモデル設定を手動で追加してください。コンテナを確認します。

```bash
docker compose ps
```

## 3. Python 依存関係のインストール

Python 3.12 を推奨します。以下は独立した仮想環境を作成し、既存の `.venv` を上書きしません。

```bash
python3.12 -m venv .venv-py312
source .venv-py312/bin/activate
python -m pip install -r requirements.txt
```

`.env` にモデル提供元の API アドレス、キー、モデル名を設定します。

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-name
MEMORY_SUMMARIZE_EVERY_TURNS=5
```

`LLM_BASE_URL` は `/chat/completions` を含まない API のルートです。提供元は OpenAI 形式の `tools` と `tool_calls` に対応している必要があります。設定変更後はワーカーを再起動してください。モデルが未設定の場合やリクエスト失敗、応答不正の場合、タスクは `FAILURE` となり、ローカルルールにはフォールバックしません。モデルのリクエストはそれぞれ 60 秒でタイムアウトします。1 ターンにつきモデル呼び出しは最大 8 回、各呼び出しでのツール呼び出しは最大 5 回です。契約書レビューでは、文字列配列の `risks` と文字列の `report` を含む JSON オブジェクトが必要です。

`MEMORY_SUMMARIZE_EVERY_TURNS` は正の整数で、既定値は 5 です。指定回数の成功ターン後に、モデルは旧要約とそのターンを新しい要約に統合し、アクティブなコンテキストから元のターンを取り除きます。次のターンは新しい要約を使用します。要約に失敗した場合、現在のタスクは失敗し、保存済みの記憶は維持されます。

入力は設定されたモデル提供元に送信されます。送信前にデータ利用およびプライバシーの条件を確認し、実際のキーをコミットしないでください。

Windows PowerShell:

```powershell
py -3.12 -m venv .venv-py312
.venv-py312\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## 4. API の起動

プロジェクトのルートで実行します。

```bash
uvicorn app.main:api --host 127.0.0.1 --port 8000
```

- Web ワークスペース: http://127.0.0.1:8000/
- Swagger: http://127.0.0.1:8000/docs
- ヘルスチェック: http://127.0.0.1:8000/health

**ローカル使用のみ**：API と UI に認証はありません。サービスに到達できるクライアントは全セッションとその内容を閲覧できます。`0.0.0.0` にバインドしたり、ネットワークに公開したりしないでください。同じマシンの他のプロセスからはアクセスされる可能性があります。

## 5. Celery ワーカーの起動

別のターミナルを開き、同じ仮想環境を有効にします。macOS では単一プロセスモードを推奨します。

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --pool=solo
```

`solo` は同時に 1 タスクのみを実行し、prefork に依存するソフト・ハードタイムアウトをサポートしません。Linux ではマルチプロセスモードを使用できます。

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --concurrency=2
```

macOS の prefork ワーカーで `fast_trace_task` の `not enough values to unpack` エラーが発生した場合、ワーカーを停止して上記の `solo` で起動してください。このエラーは業務タスクの開始前に発生することがあり、業務状態は `QUEUED` のままで Celery の状態が `FAILURE` になる場合があります。タスクが実行されなかったことを確認してから再送し、新しい `task_id` で照会してください。

### Web ワークスペースの使い方

API とワーカーを起動し、http://127.0.0.1:8000/ を開きます。「新建会话」（新規セッション）を選択し、「通用问答」（一般的な質疑応答）または「合同审查」（契約書レビュー）を選んでメッセージを送信します。同じセッションで続けて質問できます。左パネルで履歴を復元し、右パネルでタスク状態、記憶の要約、ツールの入出力を確認できます。狭い画面では「执行详情」（実行の詳細）で右パネルを開きます。同一セッションのタスクは順番に待機します。

例えば、簡潔な回答を好むことを覚えるよう依頼し、次にどの回答スタイルを好むか尋ねます。契約モードでは条項を送信してからリスクを質問できます。再読み込みすると最後に選択したセッションが復元されます。セッション、タスク、ツールイベント、チェックポイントは PostgreSQL に保存されます。モデル入力やツール出力に機密情報が含まれる場合があります。Celery の再配信時にはツールイベントが重複する場合があります。

会話欄は Markdown の見出し、リスト、引用、表、コードブロックと、`$...$`、`$$...$$`、`\(...\)`、`\[...\]` の数式をサポートします。メッセージのコピーは元のテキストをコピーし、コードブロックにもコピーボタンがあります。「查找与定位」（検索・位置移動）でメッセージを検索し、ターンや見出しから移動できます。メッセージやツール呼び出しは展開・折りたたみでき、折りたたんだメッセージには先頭行のプレビューが残ります。記憶も展開・折りたたみできます。セッションパネルを閉じるとタイトルバーも非表示になり、入力欄の左側のボタンでセッション一覧や詳細パネルを操作できます。狭い画面ではパネルはドロワーとして開きます。

各メッセージの左下にあるアイコンで原文のコピーや内容の折りたたみ・展開ができます。ツール記録は保存済みイベントを示すものであり、モデルの内部推論ではありません。生の HTML は実行されず、画像は自動読み込みされず、外部リンクはクリックした場合のみ開きます。

入力欄は初めは 1 行で、内容に応じて自動的に広がります。Enter で送信し、Shift + Enter で改行します。

描画用アセットはローカルに同梱されており、ワークスペースの実行に Node.js や外部 CDN は不要です。フロントエンドの描画依存関係または [`frontend/markdown.js`](frontend/markdown.js) を変更した後は、`npm ci && npm run build:frontend` で再生成してください。

プロジェクトのコードまたは `.env` を変更した後は API とワーカーの両方を再起動してください。待機中のタスクの実行には稼働中のワーカーが必要です。

## 6. 複数ターンのエージェントリクエスト

API とワーカーを起動します。すべてのリクエストで `mode` を指定してください。最初のリクエストで `thread_id` を省略すると、新しいセッションが作成されます。

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "chat",
    "message": "簡潔な回答が好きなことを覚えてください。"
  }')
echo "$FIRST"
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

返された `thread_id` を使って次のターンを送信します。最初のターンの完了を待つ必要はありません。同一セッションのタスクはデータベースへの登録順に実行され、異なるセッションは並列実行できます。

```bash
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"chat\",\"thread_id\":\"$THREAD_ID\",\"message\":\"私はどんな回答が好きですか？\"}")
echo "$SECOND"
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

各ターンの状態を照会し、必要に応じて `SUCCESS` または `FAILURE` になるまで繰り返します。

```bash
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

前のターンが失敗しても次のターンは実行されますが、失敗したターンは記憶に追加されません。タスク登録とキューへの配信はアトミックではありません。その間にプロセスが異常終了すると、`QUEUED` タスクが滞留して同じセッションの後続ターンをブロックすることがあり、手動での調査が必要です。

成功した質疑応答の結果は `result_json.answer` にあります。同じ `thread_id` でさらにターンを送信でき、各ターンに独立した `task_id` があります。初回に `thread_id` を省略すると新規セッションが作成されます。セッションのモードは固定され、未知の `thread_id` は 404、モード変更は 409 を返します。

契約書レビューも複数ターンに対応し、初回から `contract` を使用します。

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{"mode":"contract","message":"買主は検収後30日以内に支払うものとします。"}')
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"contract\",\"thread_id\":\"$THREAD_ID\",\"message\":\"支払条件にはどのようなリスクがありますか？\"}")
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

契約レビューの結果は `result_json.report` と `result_json.risks` にあります。質疑応答の場合、互換フィールドの `result_json.report` には同じ回答が入り、`result_json.risks` は空配列です。従来の入力フィールド `contract_text` も `message` の代わりに使用できますが、`mode` は必須です。

Celery 自体の状態を確認するには：

```bash
curl -fsS "http://localhost:8000/tasks/$TASK2/celery"
```

## 7. アーキテクチャ

| コンポーネント | 役割 |
|---|---|
| FastAPI | 業務タスクの送信と照会 |
| Redis broker | 実行待ちタスクのメッセージ配信 |
| Celery worker | バックグラウンドでのタスク実行 |
| Celery result backend | Celery の状態と戻り値の保存 |
| LangGraph | エージェントノードの編成 |
| PostgreSQL 業務テーブル | セッション、送信順、タスク状態と結果の保存 |
| PostgreSQL checkpointer | LangGraph のチェックポイントとアクティブな記憶の保存 |

`task_id`、`thread_id`、`checkpoint_id` は異なります。

- `task_id`：1 件の Celery バックグラウンドタスク。
- `thread_id`：LangGraph ワークフローの状態。
- `checkpoint_id`：特定のチェックポイント。

要約はモデルに送信するアクティブなコンテキストを置き換えますが、過去のチェックポイントやタスクの元入力・結果を物理的に削除しません。セッション ID は認証ではありません。本番環境には認証、テナント分離、データ保持ポリシーが必要です。

## 8. 本番環境に向けた改修

これは実行可能な最小限のひな形であり、改修せずに本番の機密データを扱うべきではありません。少なくとも以下が必要です。

1. **確実な配信**：登録と Celery への配信は別操作です。トランザクショナルアウトボックスを検討してください。
2. **冪等性**：Celery はタスクを再配信することがあります。副作用のあるツールには業務上の冪等キーと結果照合を使用してください。
3. **タスク状態管理**：再試行回数、キャンセル、リース／ハートビート、失敗分類、手動復旧を追加します。
4. **進捗**：LangGraph のノード境界で進捗を更新するか、イベントストリームにノードイベントを記録します。
5. **大容量ファイル**：大型 PDF やバイナリはオブジェクトストレージにアップロードし、キューには URI のみを渡します。
6. **セキュリティ**：認証、テナント分離、入力検証、マスキング、TLS、秘密情報の管理、監査ログを追加します。
7. **監視**：キュー長、ワーカーの稼働状態、実行時間、失敗率、チェックポイント保存領域を監視します。
8. **タイムアウト**：外部 API、Celery のソフト／ハード制限、Redis visibility timeout を設定し、長時間タスクの可視性と再配信を検証します。
9. **データベース接続**：接続プールを使い、接続上限、バックアップ、マイグレーションを設定します。

## 9. 復旧時の動作

チェックポイントが保存するのは LangGraph の永続化されたワークフロー状態であり、Python 関数の実行スタックではありません。ノードが次のチェックポイントを生成する前にクラッシュすると、復旧時に再実行されることがあります。外部操作の副作用には冪等性が必要です。

このデモのグラフノードは同期的に実行され、Celery ワーカーがグラフ全体をバックグラウンドで実行します。細粒度の復旧には、適切に分割された LangGraph ノードと、復旧可能な出力および冪等な外部操作が必要です。
