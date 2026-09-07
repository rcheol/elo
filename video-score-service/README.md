# HoneyServe Video Score Service

유튜브 경기 영상 링크에서 배드민턴 복식 최종 스코어를 추출하기 위한 별도 백엔드입니다. 현재 실제로 사용할 수 있는 멀티모달 모델을 `base/gemma-4-31b-it` 하나로 보고, 영상은 직접 모델에 통째로 넣지 않고 프레임으로 쪼개 분석합니다.

## 선택한 방향

1. Primary: base/gemma-4-31b-it
   - 직접 GPU 서버를 띄우지 않고, 보유한 API 키로 호출하는 전제를 둡니다.
   - YouTube URL을 직접 넘기지 않고, 서비스가 `yt-dlp + ffmpeg`로 프레임을 샘플링한 뒤 OpenAI-compatible chat/completions API에 이미지로 전달합니다.
   - 먼저 초반/중반 프레임으로 4명 슬롯을 만들고, 사용자가 각 슬롯을 실제 선수로 매핑합니다.
   - 이후 전체 영상 프레임을 여러 batch로 분석해서 점수판 readings를 모으고, 마지막 유효 스코어를 최종 후보로 반환합니다.

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
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# .env 파일에 GEMINI_API_KEY 입력
uvicorn app.main:app --reload --port 8088
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

## Render 배포 메모

새 Web Service를 별도로 만들 때:

- Root Directory: `video-score-service`
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Environment Variables:
  - `GEMINI_API_KEY`: Google AI Studio API key
  - `GEMINI_VIDEO_MODEL`: `gemini-3.8-flash`
  - `GEMINI_VIDEO_PROCESSING`: `agentic`
  - `GEMMA_API_KEY`: base/gemma-4-31b-it 호출 키
  - `GEMMA_CHAT_COMPLETIONS_URL`: OpenAI-compatible `/v1/chat/completions` URL
  - `GEMMA_MODEL`: `base/gemma-4-31b-it`

Docker로 배포하는 경우 `Dockerfile`을 그대로 사용하면 됩니다.

## 정확도 운영 방식

처음부터 자동 등록까지 한 번에 연결하지 말고, 아래 순서로 가는 것을 권장합니다.

1. 유튜브 URL을 넣으면 후보 스코어와 근거 timestamp를 반환
2. 관리자 화면에서 사람이 확인 후 경기 기록 저장
3. Gemini 결과가 애매하면 `provider=gemma_frames`로 마지막 구간 프레임을 재검증
4. 영상 샘플이 20개 정도 쌓이면 오답 유형을 보고 OCR fallback 추가
5. 점수판 위치가 일정하면 마지막 20% 구간 OCR + Gemini/Gemma 검증 조합으로 강화
