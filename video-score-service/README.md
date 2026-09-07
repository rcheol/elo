# HoneyServe Video Score Service

유튜브 경기 영상 링크에서 배드민턴 복식 최종 스코어를 추출하기 위한 별도 백엔드입니다. 현재 실제로 사용할 수 있는 멀티모달 모델을 `base/gemma-4-31b-it` 하나로 보고, 영상은 직접 모델에 통째로 넣지 않고 프레임으로 쪼개 분석합니다.

Render 배포 서버에서는 Gemma API가 사내 IP 제한으로 timeout될 수 있으므로, 운영 구조는 “메인 사이트가 DB 큐를 저장하고, 회사망 PC의 로컬 worker가 큐를 polling해서 Gemma를 호출하는 방식”입니다.

## 선택한 방향

1. Primary: base/gemma-4-31b-it
   - 직접 GPU 서버를 띄우지 않고, 보유한 API 키로 호출하는 전제를 둡니다.
   - YouTube URL을 직접 넘기지 않고, 서비스가 `yt-dlp + ffmpeg`로 프레임을 샘플링한 뒤 OpenAI-compatible chat/completions API에 이미지로 전달합니다.
   - 먼저 초반/중반 프레임으로 4명 슬롯을 만들고, 사용자가 각 슬롯을 실제 선수로 매핑합니다.
   - 이후 전체 영상을 짧은 타임라인 이미지로 쪼개서 서브/랠리 종료 흐름을 판정하고, 랠리 승자에게 1점씩 누적해 최종 후보를 반환합니다.

2. Optional legacy fallback: Gemini 3.8 Flash video understanding
   - Gemini 키가 있으면 public YouTube URL 직접 분석 경로도 남겨둘 수 있습니다.
   - 현재 요구사항에서는 필수가 아닙니다.

3. Fallback 후보: TwelveLabs Pegasus / Jockey
   - 영상 분석 전문 API입니다.
   - 한 영상에 대한 질문/분석과 structured JSON 응답에 강점이 있습니다.
   - 현재 서비스에는 후보로만 남겨두고, 실제 키가 준비되면 provider를 추가합니다.

4. 정확도 보강 후보: yt-dlp + ffmpeg + PaddleOCR
   - 영상에서 마지막 구간과 점수판 후보 프레임을 샘플링합니다.
   - OCR로 숫자를 읽고 시간축 투표를 해서 최종 스코어를 보강합니다.
   - 점수판 위치가 일정한 동호회 영상이 쌓이면 이 경로가 가장 안정적인 검증 레이어가 됩니다.

## 로컬 실행

```powershell
cd E:\github\badminton-elo-ranking\video-score-service
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# .env 파일에 GEMMA_API_KEY, GEMMA_CHAT_COMPLETIONS_URL 입력
uvicorn app.main:app --reload --port 8088
```

## 메인 사이트 큐 worker 실행

메인 랭킹 사이트(`honeyserve-elo.onrender.com`)에서 유튜브 링크를 등록하면, 작업은 Neon/Postgres의 `app_state.videoAnalysisJobs`에 저장됩니다. 회사망 PC에서는 아래 worker를 켜두면 됩니다.

Render 메인 사이트 환경변수:

- `VIDEO_WORKER_TOKEN`: 긴 랜덤 문자열 하나를 설정합니다.
- `VIDEO_JOB_LOCK_MINUTES`: 선택값, 기본 60분입니다. worker가 중간에 죽으면 이 시간이 지난 뒤 작업이 다시 큐에 잡힙니다.

회사망 PC `video-score-service\.env`:

```powershell
WORKER_API_BASE_URL=https://honeyserve-elo.onrender.com
VIDEO_WORKER_TOKEN=Render에 넣은 값과 동일하게
GEMMA_API_KEY=보유한 Gemma 호출 키
GEMMA_CHAT_COMPLETIONS_URL=https://infinia-api.dev-aibixby.com/oai/v1/chat/completions
GEMMA_MODEL=base/gemma-4-31b-it
GEMMA_VERIFY_TLS=false
GEMMA_FRAME_MAX_HEIGHT=360
GEMMA_FRAME_JPEG_QUALITY=16
GEMMA_PLAYER_FRAME_MAX_HEIGHT=480
GEMMA_PLAYER_FRAME_JPEG_QUALITY=18
GEMMA_REQUEST_MAX_BYTES=40000
GEMMA_SCORE_SCAN_INTERVAL_SECONDS=1
GEMMA_SCORE_SCAN_MAX_FRAMES=1200
GEMMA_SCORE_SCAN_BATCH_SIZE=1
GEMMA_RALLY_FRAME_MAX_HEIGHT=160
GEMMA_RALLY_FRAME_JPEG_QUALITY=24
GEMMA_RALLY_WINDOW_FRAMES=4
GEMMA_RALLY_MIN_CONFIDENCE=0.55
YTDLP_VERIFY_TLS=false
WORKER_VERIFY_TLS=false
WORKER_RESULT_UPLOAD_SOFT_LIMIT_BYTES=40000
WORKER_REFERENCE_FRAME_MAX_HEIGHT=480
WORKER_REFERENCE_FRAME_JPEG_QUALITY=18
REQUEST_TIMEOUT_SECONDS=300
```

`WORKER_VERIFY_TLS=false`는 로컬 worker가 Render 큐 서버에 붙을 때 Python 인증서 검증에서 막히는 경우에만 사용합니다. 사내 SSL 프록시나 로컬 Python CA 문제로 `[SSL: CERTIFICATE_VERIFY_FAILED]`가 나면 이 값을 false로 두고 다시 실행하면 됩니다.
`YTDLP_VERIFY_TLS=false`는 `yt-dlp`가 YouTube 페이지/API를 읽을 때 같은 인증서 검증 오류가 나는 경우에 사용합니다.
회사망 업로드 제한으로 `Access Upload Denied`가 나면 Gemma 요청과 worker 결과 업로드 크기를 줄여야 합니다. 기본 Gemma 요청 제한은 `GEMMA_REQUEST_MAX_BYTES=40000`, worker 결과 업로드 목표 크기는 `WORKER_RESULT_UPLOAD_SOFT_LIMIT_BYTES=40000`입니다.
Player mapping uses separate higher-resolution frames (`GEMMA_PLAYER_FRAME_MAX_HEIGHT=480`) and checks every candidate frame before choosing the clearest one. The worker keeps that reference image at full quality when the upload payload is already under `WORKER_RESULT_UPLOAD_SOFT_LIMIT_BYTES`; it only downscales as a fallback.

실행:

```powershell
cd E:\github\badminton-elo-ranking\video-score-service
.\..\tmp\video-score-venv310\Scripts\Activate.ps1
python worker.py
```

worker 흐름:

1. `GET /api/video-analysis/worker/jobs/next`로 다음 작업을 가져옵니다.
2. `player_detection`이면 유튜브 프레임을 추출하고 Gemma로 `A1/A2/B1/B2` 슬롯을 만듭니다.
3. 사용자가 사이트에서 슬롯별 선수를 고르면 작업이 `score_analysis`로 다시 큐에 들어갑니다.
4. worker가 영상 전체의 서브/랠리 종료 흐름을 분석해 최종 스코어 후보를 저장합니다.
5. 사용자가 “이 점수로 경기 저장”을 누르면 기존 경기 등록 API와 같은 ELO 재계산 경로로 기록됩니다.

## 메인 사이트 큐 API

### 영상 작업 생성

```http
POST /api/video-analysis/jobs
Content-Type: application/json
```

```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

### 영상 작업 조회

```http
GET /api/video-analysis/jobs/{jobId}
```

### 선수 매핑 저장 및 점수 분석 큐 등록

```http
PUT /api/video-analysis/jobs/{jobId}/players
Content-Type: application/json
```

```json
{
  "slots": {
    "A1": { "playerId": "player-a1" },
    "A2": { "playerId": "player-a2" },
    "B1": { "playerId": "player-b1" },
    "B2": { "playerId": "player-b2" }
  }
}
```

### 점수 확인 후 경기 등록

```http
POST /api/video-analysis/jobs/{jobId}/confirm
Content-Type: application/json
```

```json
{
  "playedAt": "2026-09-07T20:30:00+09:00"
}
```

## API

### Health

```http
GET /healthz
```

### 사용 가능한 provider 확인

```http
GET /models
```

## 새 영상 등록 플로우

이 기능은 “모델이 사람 이름을 맞히는” 방식이 아닙니다. 모델은 영상 속 4명을 `A1`, `A2`, `B1`, `B2` 슬롯으로만 나누고, 실제 선수 이름은 사용자가 직접 지정합니다.

### 1. 영상 세션 생성

```http
POST /video-sessions
Content-Type: application/json
```

```json
{
  "youtube_url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "hint": "카메라는 A팀 뒤쪽에서 촬영됨",
  "calibration_max_frames": 4
}
```

응답의 `reference_frames`와 `player_slots`를 화면에 보여주면 됩니다. 프론트에서는 사용자가 각 슬롯을 실제 선수로 선택하게 만듭니다.

### 2. 4명 슬롯을 실제 선수로 매핑

```http
PUT /video-sessions/{session_id}/players
Content-Type: application/json
```

```json
{
  "slots": {
    "A1": { "player_id": "player-a1", "player_name": "류철" },
    "A2": { "player_id": "player-a2", "player_name": "백지영" },
    "B1": { "player_id": "player-b1", "player_name": "박성수" },
    "B2": { "player_id": "player-b2", "player_name": "홍석기" }
  }
}
```

### 3. 전체 영상 스코어 분석 시작

```http
POST /video-sessions/{session_id}/score-jobs
Content-Type: application/json
```

```json
{
  "scan_interval_seconds": 20,
  "max_frames": 96,
  "batch_size": 8,
  "hint": "점수판은 화면 상단 중앙에 있음"
}
```

분석이 오래 걸릴 수 있으므로 `GET /video-sessions/{session_id}`로 상태를 조회합니다. 완료되면 `score_result.score`, `score_result.readings`, `score_result.match_payload`가 채워집니다.

### 4. 사용자가 점수 확인

```http
POST /video-sessions/{session_id}/confirm
Content-Type: application/json
```

```json
{
  "confirmed": true,
  "played_at": "2026-09-07T20:30:00+09:00"
}
```

응답의 `match_payload`를 기존 랭킹 사이트의 `POST /api/matches`에 보내면 최종 기록 등록이 됩니다.

### 영상 분석

```http
POST /analyze
Content-Type: application/json
```

```json
{
  "youtube_url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "provider": "auto",
  "expected_players": ["류철", "박성수", "백지영", "홍석기"],
  "hint": "점수판은 화면 상단에 있고, 마지막에 표시되는 경기 최종 점수를 우선해줘.",
  "frame_tail_seconds": 600,
  "frame_max_frames": 12
}
```

응답 예시:

```json
{
  "status": "succeeded",
  "provider": "gemini",
  "model": "gemini-3.8-flash",
  "score": {
    "team_a": 21,
    "team_b": 18,
    "winner": "A",
    "confidence": 0.86
  },
  "evidence": [
    {
      "timestamp": "18:42",
      "text": "마지막 점수판에서 21-18로 보임"
    }
  ],
  "warnings": [],
  "raw": null
}
```

### 긴 영상 분석 작업 시작

```http
POST /jobs
Content-Type: application/json
```

요청 body는 `/analyze`와 같습니다. 응답의 `poll_url`을 조회하면 됩니다.

```http
GET /jobs/{job_id}
```

## 선택형 별도 분석 서비스 배포 메모

사내 IP 제한이 없는 모델 키를 쓰게 될 때만 새 Web Service를 별도로 만들면 됩니다. 현재 Infinia/Gemma 키는 Render에서 timeout될 수 있으므로, 위의 로컬 worker 방식을 우선 사용합니다.

- Root Directory: `video-score-service`
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Environment Variables:
  - `GEMINI_API_KEY`: Google AI Studio API key
  - `GEMINI_VIDEO_MODEL`: `gemini-3.8-flash`
  - `GEMINI_VIDEO_PROCESSING`: `agentic`
  - `GEMMA_API_KEY`: Render에서 접근 가능한 base/gemma-4-31b-it 호출 키
  - `GEMMA_CHAT_COMPLETIONS_URL`: Render에서 접근 가능한 OpenAI-compatible `/v1/chat/completions` URL
  - `GEMMA_MODEL`: `base/gemma-4-31b-it`
  - `GEMMA_VERIFY_TLS`: curl의 `-k`가 필요한 사내 dev endpoint라면 `false`

Docker로 배포하는 경우 `Dockerfile`을 그대로 사용하면 됩니다.

## 정확도 운영 방식

처음부터 자동 등록까지 한 번에 연결하지 말고, 아래 순서로 가는 것을 권장합니다.

1. 유튜브 URL을 넣으면 worker가 선수 슬롯 후보와 기준 프레임을 반환
2. 사용자가 A1/A2/B1/B2를 실제 선수와 연결
3. worker가 영상 전체를 scan해서 후보 스코어와 근거 timestamp를 반환
4. 사용자가 점수를 확인하면 기존 경기 기록 저장 API로 등록
5. 영상 샘플이 20개 정도 쌓이면 오답 유형을 보고 OCR fallback 추가
