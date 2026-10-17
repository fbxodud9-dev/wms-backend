// 발주 목록(GET /orders) 메모리 절약용
// - 여러 PC가 동시에 발주 목록을 요청하면(다른 직원이 업로드·수정한 직후 5초 안에 모든 화면이 다시 불러옴)
//   예전에는 요청마다 DB에서 10만 줄을 받아 따로따로 크게 만들어서 서버 메모리가 넘쳤음
// - 이제는 DB가 JSON 글자 하나로 만들어 주고, 같은 순간 들어온 요청들은 그 결과 하나를 같이 씀
// - 데이터가 바뀌는 요청(GET 말고 전부)이 오면 번호를 올려서, 바뀐 뒤 요청은 절대 예전 결과를 받지 않게 함
let writeSeq = 0;
const inflight = new Map(); // key -> Promise<string>

function bumpOnWrite(req, res, next) {
  if (req.method !== "GET" && req.method !== "OPTIONS" && req.method !== "HEAD") {
    writeSeq++;
    res.on("finish", () => {
      writeSeq++;
    });
  }
  next();
}

// loader: () => Promise<string>. 같은 key + 같은 writeSeq 동안 진행 중인 결과를 함께 씀 (끝나면 바로 버림 = 오래된 캐시 없음)
function shared(key, loader) {
  const k = `${key}#${writeSeq}`;
  if (inflight.has(k)) return inflight.get(k);
  const p = Promise.resolve()
    .then(loader)
    .finally(() => {
      inflight.delete(k);
    });
  inflight.set(k, p);
  return p;
}

module.exports = { bumpOnWrite, shared };
