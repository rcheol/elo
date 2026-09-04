# HoneyServe Video Score Service

유튜브 경기 영상 링크에서 배드민턴 복식 최종 스코어를 추출하기 위한 별도 백엔드입니다. 트래픽보다 분석 정확도와 운영 가능성이 중요하므로, 1차 엔진은 public YouTube URL을 직접 받을 수 있는 Gemini Video Understanding으로 구성했습니다.

## 선택한 방향

1. Primary: Gemini 3.8 Flash video understanding
   - public YouTube URL을 직접 입력으로 넣습니다.
   - agentic video processing을 우선 사용해서 긴 영상에서도 필요한 구간을 모델이 탐색하도록 둡니다.
   - 결과는 `found`, `scoreA`, `scoreB`, `winner`, `confidence`, `evidence` 형태의 JSON으로 제한합니다.

2. Fallback 후보: TwelveLabs Pegasus / Jockey
   - 영상 분석 전문 API입니다.
   - 한 영상에 대한 질문/분석과 structured JSON 응답에 강점이 있습니다.
   - 현재 서비스에는 후보로만 남겨두고, 실제 키가 준비되면 provider를 추가합니다.

3. 정확도 보강 후보: yt-dlp + ffmpeg + PaddleOCR
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
  "hint": "점수판은 화면 상단에 있고, 마지막에 표시되는 경기 최종 점수를 우선해줘."
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

Docker로 배포하는 경우 `Dockerfile`을 그대로 사용하면 됩니다.

## 정확도 운영 방식

처음부터 자동 등록까지 한 번에 연결하지 말고, 아래 순서로 가는 것을 권장합니다.

1. 유튜브 URL을 넣으면 후보 스코어와 근거 timestamp를 반환
2. 관리자 화면에서 사람이 확인 후 경기 기록 저장
3. 영상 샘플이 20개 정도 쌓이면 오답 유형을 보고 OCR fallback 추가
4. 점수판 위치가 일정하면 마지막 20% 구간 OCR + Gemini 검증 조합으로 강화
