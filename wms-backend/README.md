# WMS 백엔드 (허브센터 핵심 흐름: 발주정보 → 피킹지시서변환 → 피킹 → 출고)

## 1. 로컬에서 먼저 확인 (선택)
```
npm install
cp .env.example .env   # 값 채워넣기
npm run migrate        # 테이블 생성
npm run seed            # 초기 계정 + 샘플 품목 생성
npm start
```

## 2. Google Cloud SQL(PostgreSQL) 준비
1. Google Cloud Console → SQL → 인스턴스 만들기 → PostgreSQL 선택
2. 데이터베이스 생성 (예: `wms`)
3. 사용자 생성 (예: `wms_user` / 비밀번호)
4. "연결" 탭에서 공인 IP 주소 확인, "승인된 네트워크"에 `0.0.0.0/0` 추가 (또는 Render 고정 IP만 허용 — 더 안전)
5. 접속 문자열 조합: `postgres://wms_user:비밀번호@공인IP:5432/wms`

## 3. GitHub에 코드 올리기
이 폴더(`wms-backend`) 전체를 새 GitHub 저장소로 push 하세요.
```
git init
git add .
git commit -m "wms backend"
git remote add origin <저장소 주소>
git branch -M main
git push -u origin main
```

## 4. Render에 배포
1. Render 대시보드 → New + → **Web Service**
2. 방금 push한 GitHub 저장소 연결
3. 설정값:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **Environment** 탭에서 환경변수 등록 (`.env.example` 참고):
   - `DATABASE_URL`
   - `DB_SSL` = `true`
   - `JWT_SECRET` (긴 무작위 문자열)
   - `FRONTEND_ORIGIN` = Vercel 배포 주소 (예: `https://wms-demo-liard.vercel.app`)
5. Create Web Service 클릭 → 배포 완료 후 주소 확인 (예: `https://wms-backend-xxxx.onrender.com`)

## 5. 최초 1회 테이블 생성 + 계정 시드
Render 대시보드의 서비스 → **Shell** 탭에서:
```
npm run migrate
npm run seed
```
시드가 끝나면 콘솔에 `staff1 / wms1234`, `staff2 / wms1234` 계정이 출력됩니다. 로그인 후 반드시 `/auth/change-password`로 비밀번호를 바꾸세요.

## 6. 동작 확인
```
curl https://<render 주소>/health
```
`{"ok":true}` 가 나오면 정상입니다.

## API 요약
| 단계 | 메서드 | 경로 | 설명 |
|---|---|---|---|
| 로그인 | POST | /auth/login | { username, password } → 토큰 발급 |
| 발주정보 | GET | /orders | 전체 발주 조회 |
| 발주정보 | POST | /orders | 발주 등록(엑셀 파싱 결과/수동입력) |
| 피킹지시서변환 | POST | /orders/convert-to-picking | { supplierKey } 공급사 단위 일괄 할당 |
| 피킹 | PATCH | /orders/:id/lines/:sku/pick | { picked } 체크 |
| 피킹 | POST | /orders/:id/confirm-pick | 지시서 확정(문서번호 발급) |
| 피킹 | GET | /orders/picking-docs | 지시서 목록 |
| 피킹 | POST | /orders/picking-docs/:docNo/reissue | 재발행 |
| 출고 | POST | /orders/:id/ship | 재고 차감 + 출고완료 |
| 출고 | POST | /orders/:id/confirm-pms | PMS 전송 확정 |
| 재고 | GET | /items | 전체 품목 |
| 재고 | POST | /items/:sku/inbound | 입고 |
| 재고 | POST | /items/:sku/outbound | 출고(개별) |
| 이력 | GET | /transactions | 입출고 이력 |

모든 API(로그인 제외)는 `Authorization: Bearer <토큰>` 헤더가 필요합니다.
