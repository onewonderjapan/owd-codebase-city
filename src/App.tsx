import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildModel,
  SAMPLE_REPO,
  SAMPLE_ISSUES,
  KVARS,
  type CityFile,
} from "./lib/repo";
import { createCity, type City, type MarkMode } from "./lib/city";
import { trpc } from "@/providers/trpc";
import { ISSUE_LABEL, type AnalysisResult, type Severity } from "@contracts/types";

const SEV_NAME: Record<Severity, string> = { high: "高", medium: "中", low: "低" };

export default function App() {
  /* ── データ：null = サンプルリポジトリ ── */
  const [data, setData] = useState<AnalysisResult | null>(null);
  const model = useMemo(
    () => buildModel(data ? data.files : SAMPLE_REPO, data ? data.issues : SAMPLE_ISSUES),
    [data],
  );
  const modelId = data ? `${data.meta.repo}@${data.meta.commit.slice(0, 7)}` : "sample";

  /* ── ビュー状態 ── */
  const [ok, setOk] = useState(true);
  const [hMode, setHMode] = useState("loc");
  const [flow, setFlow] = useState(true);
  const [hatch, setHatch] = useState(true);
  const [spin, setSpin] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [sel, setSelS] = useState<CityFile | null>(null);
  const [query, setQuery] = useState("");
  const [mark, setMark] = useState<MarkMode>(null);
  const [tab, setTab] = useState<"issues" | "detail">("issues");
  const [drawer, setDrawer] = useState(false); // モバイル左カラム
  const [sheet, setSheet] = useState(false); // モバイル右カラム

  /* ── リポジトリ入力 ── */
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [err, setErr] = useState("");

  const analyze = trpc.repo.analyze.useMutation({
    onSuccess: (d) => {
      setData(d);
      setSelS(null);
      setMark(null);
      setTab("issues");
      setErr("");
      setZoom(100);
    },
    onError: (e) => setErr(e.message),
  });
  const recent = trpc.repo.recent.useQuery(undefined, { retry: false, staleTime: 30_000 });

  const submit = (target?: string) => {
    const u = (target ?? url).trim();
    if (!u || analyze.isPending) return;
    if (target) setUrl(target);
    analyze.mutate({ url: u, token: token.trim() || undefined });
  };

  /* ── 都市インスタンス：モデルが変わったら再生成 ── */
  const cv = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const city = useRef<City | null>(null);

  useEffect(() => {
    const c = createCity(cv.current, stage.current, tip.current, model, {
      onSelect: (f) => {
        setSelS(f);
        if (f) {
          setTab("detail");
          setSheet(true);
        }
      },
      onZoom: (z) => setZoom(z),
    });
    if (!c) {
      setOk(false);
      return;
    }
    setOk(true);
    city.current = c;
    c.onSpinChange((v) => setSpin(v));
    return () => {
      c.dispose();
      city.current = null;
    };
  }, [model]);

  useEffect(() => {
    city.current?.setSel(sel);
  }, [sel, model]);
  useEffect(() => {
    city.current?.setQuery(query);
  }, [query, model]);
  useEffect(() => {
    city.current?.setMarkMode(mark);
  }, [mark, model]);

  const select = (f: CityFile | null) => {
    setSelS((s) => (s === f ? null : f));
    if (f) {
      setTab("detail");
      setSheet(true);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA)$/.test(t.tagName)) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape") setSelS(null);
      else if (e.key === "=" || e.key === "+") city.current?.dolly(1 / 1.18);
      else if (e.key === "-" || e.key === "_") city.current?.dolly(1.18);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  /* ── 左カラムのツリー ── */
  const tree: React.ReactNode[] = [];
  for (const d of model.dirs) {
    const fs = model.files.filter(
      (f) => f.dir === d && (!query || f.path.toLowerCase().includes(query)),
    );
    if (!fs.length) continue;
    tree.push(
      <div className="tr dir" key={"d" + d}>
        <span className="sw" style={{ background: model.colorOf(fs[0]) }} />
        <span className="nm">{d + "/"}</span>
        <span className="lc">{fs.reduce((a, f) => a + f.loc, 0)}</span>
      </div>,
    );
    for (const f of fs)
      tree.push(
        <div
          className={"tr" + (f === sel ? " on" : "") + (f.isolated ? " iso" : "")}
          key={f.path}
          onClick={() => select(f)}
          onMouseOver={() => city.current?.setRailHover(f)}
        >
          <span className="sw" style={{ background: model.colorOf(f), opacity: 0.5 }} />
          <span className="nm" style={{ paddingLeft: "9px" }}>
            {f.name}
            {f.issueRank > 0 && <i className={`dot r${f.issueRank}`} title="問題フラグあり" />}
          </span>
          <span className="lc">{f.loc}</span>
        </div>,
      );
  }

  const depList = (title: string, arr: string[]) =>
    arr.length ? (
      <>
        <h3>
          {title + " "}
          <span style={{ color: "var(--faint)" }}>{arr.length}</span>
        </h3>
        {arr.map((p) => (
          <div className="dep" key={p} onClick={() => setSelS(model.FMAP[p] ?? null)}>
            <span className="sw" style={{ background: model.colorOf(model.FMAP[p]) }} />
            <span>{p}</span>
          </div>
        ))}
      </>
    ) : null;

  const issues = data ? data.issues : SAMPLE_ISSUES;
  const isoCount = model.files.filter((f) => f.isolated).length;
  const repoName = data ? data.meta.repo : "サンプルリポジトリ";

  return (
    <div id="app" className={drawer ? "drawer" : ""}>
      {/* ── 左カラム ── */}
      <aside>
        <div className="hd">
          <h1>コード・シティ</h1>
          <div className="repo" title={repoName}>
            {repoName}
            {!data && <em> · サンプル</em>}
            {data?.meta.truncated && <em> · ディレクトリ集約済み</em>}
            {data?.meta.fromCache && <em> · キャッシュ</em>}
          </div>
          <div className="kpis">
            <div>
              <b>{model.files.length}</b>
              <i>ファイル</i>
            </div>
            <div>
              <b>{model.totalLoc.toLocaleString()}</b>
              <i>行数</i>
            </div>
            <div>
              <b>{model.edges.length}</b>
              <i>依存</i>
            </div>
            <div>
              <b className={issues.length ? "warn" : ""}>{issues.length}</b>
              <i>問題</i>
            </div>
          </div>
        </div>

        <div className="load">
          <div className="row">
            <input
              type="text"
              placeholder="owner/repo または GitHub URL"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button className="go" disabled={analyze.isPending || !url.trim()} onClick={() => submit()}>
              {analyze.isPending ? "…" : "分析"}
            </button>
          </div>
          {analyze.isPending && (
            <div className="prog">
              <span className="spin" />
              取得して依存を解析中。大きなリポジトリは数十秒かかります…
            </div>
          )}
          {err && <div className="err">{err}</div>}
          <button className="tok" type="button" onClick={() => setShowToken((v) => !v)}>
            {showToken ? "トークンを閉じる ▴" : "プライベート／レート制限？トークンを使う ▾"}
          </button>
          {showToken && (
            <input
              type="password"
              placeholder="GitHub トークン（任意・この分析のみに使用）"
              value={token}
              spellCheck={false}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
          {!!recent.data?.length && (
            <div className="recent">
              <span>最近の分析：</span>
              {recent.data.slice(0, 5).map((r) => (
                <button key={r.repo + r.branch} type="button" onClick={() => submit(r.repo)}>
                  {r.repo}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="q">
          <input
            type="search"
            placeholder="ファイル／ディレクトリを検索…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value.trim().toLowerCase())}
          />
        </div>
        <div className="tree" onMouseLeave={() => city.current?.setRailHover(null)}>
          {tree.length ? tree : <div className="empty">一致するファイルがありません</div>}
        </div>
      </aside>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

      {/* ── 中央：都市 ── */}
      <div id="stage" ref={stage}>
        <canvas id="cv" key={modelId} ref={cv} />
        <div id="tip" ref={tip} />
        <button id="menu" type="button" aria-label="メニュー" onClick={() => setDrawer(true)}>
          ☰
        </button>
        <div id="crumb">
          {repoName.toUpperCase()} /{" "}
          <b>
            {sel
              ? sel.path.toUpperCase()
              : mark === "iso"
                ? `孤立コード ×${isoCount}`
                : mark === "issue"
                  ? `問題マーク ×${issues.length}`
                  : hMode === "loc"
                    ? "OVERVIEW"
                    : "BY FAN-IN"}
          </b>
        </div>
        <div id="legend">
          {model.TOPS.slice(0, 8).map((t, i) => (
            <div key={t}>
              <i style={{ background: `var(${KVARS[i % KVARS.length]})` }} />
              {t + "/"}
            </div>
          ))}
          <div style={{ marginTop: "6px", color: "var(--faint)" }}>
            {`高さ = ${hMode === "loc" ? "行数" : "被依存数"} · 流れる点 = import の向き`}
          </div>
          {mark && (
            <div className="markkey">
              <i style={{ background: "#ff3d5e" }} />
              {mark === "iso" ? "孤立ファイル（出入りなし）" : "問題ファイル（赤＝高 / 橙＝中 / 黄＝低）"}
            </div>
          )}
        </div>
        <div id="bar">
          {[
            ["loc", "高さ＝行数"],
            ["dep", "高さ＝被依存"],
          ].map(([v, label]) => (
            <button
              key={v}
              className={"tb" + (hMode === v ? " on" : "")}
              type="button"
              onClick={() => {
                model.setHeightMode(v);
                setHMode(v);
              }}
            >
              {label}
            </button>
          ))}
          <div className="vsep" />
          <button
            className={"tb" + (flow ? " on" : "")}
            type="button"
            onClick={() =>
              setFlow((v) => {
                city.current?.setFlow(!v);
                return !v;
              })
            }
          >
            依存フロー
          </button>
          <button
            className={"tb" + (hatch ? " on" : "")}
            type="button"
            onClick={() =>
              setHatch((v) => {
                city.current?.setHatch(!v);
                return !v;
              })
            }
          >
            グロー
          </button>
          <button
            className={"tb" + (spin ? " on" : "")}
            type="button"
            onClick={() =>
              setSpin((v) => {
                city.current?.setSpin(!v);
                return !v;
              })
            }
          >
            回転
          </button>
          <div className="vsep" />
          <button
            className={"tb mark" + (mark === "iso" ? " on" : "")}
            type="button"
            disabled={!isoCount}
            title={isoCount ? `${isoCount} 個の孤立ファイルをハイライト` : "このリポジトリに孤立ファイルはありません"}
            onClick={() => setMark((m) => (m === "iso" ? null : "iso"))}
          >
            孤立コード{isoCount ? `·${isoCount}` : ""}
          </button>
          <button
            className={"tb mark" + (mark === "issue" ? " on" : "")}
            type="button"
            disabled={!issues.length}
            title="深刻度別に問題ファイルをマーク"
            onClick={() => setMark((m) => (m === "issue" ? null : "issue"))}
          >
            問題{issues.length ? `·${issues.length}` : ""}
          </button>
          <div className="vsep" />
          <button className="tb" type="button" title="ズームアウト" onClick={() => city.current?.dolly(1.18)}>
            −
          </button>
          <button className="tb" type="button" title="クリックで標準の距離に戻す" onClick={() => city.current?.reset()}>
            {zoom + "%"}
          </button>
          <button className="tb" type="button" title="ズームイン" onClick={() => city.current?.dolly(1 / 1.18)}>
            ＋
          </button>
          <div className="vsep" />
          <button
            className="tb"
            type="button"
            onClick={() => {
              city.current?.reset();
              setSelS(null);
              setMark(null);
            }}
          >
            リセット
          </button>
        </div>
        <button id="fab" type="button" onClick={() => setSheet(true)}>
          問題 · {issues.length}
        </button>
        <div id="gate" style={ok ? undefined : { display: "grid" }}>
          このデバイスでは WebGL が使えません。
          <br />
          左のツリーと右の分析結果はそのまま利用できます。
        </div>
      </div>

      {/* ── 右カラム：問題一覧 / ファイル詳細 ── */}
      <div id="side" className={sheet ? "open" : ""}>
        <div id="dt">
          <div className="tabs">
            <button
              className={tab === "issues" ? "on" : ""}
              type="button"
              onClick={() => setTab("issues")}
            >
              問題一覧 <b>{issues.length}</b>
            </button>
            <button
              className={tab === "detail" ? "on" : ""}
              type="button"
              disabled={!sel}
              onClick={() => setTab("detail")}
            >
              ファイル詳細
            </button>
            <button className="x" type="button" aria-label="閉じる" onClick={() => setSheet(false)}>
              ×
            </button>
          </div>

          {tab === "issues" && (
            <div className="issues">
              {!issues.length && <div className="empty">目立った問題は見つかりませんでした —— きれいな街です。</div>}
              {issues.map((iss, ix) => (
                <div className={`iss ${iss.severity}`} key={ix}>
                  <div className="hd2">
                    <i className={`dot ${iss.severity}`} />
                    <span className="tt">{iss.title}</span>
                    <span className="tag">{ISSUE_LABEL[iss.type]}</span>
                    <span className="sev">{SEV_NAME[iss.severity]}</span>
                  </div>
                  <div className="dtl">{iss.detail}</div>
                  <div className="acts">
                    <button
                      type="button"
                      onClick={() => setMark((m) => (m === "issue" ? null : "issue"))}
                    >
                      {mark === "issue" ? "マーク解除" : "都市でマーク"}
                    </button>
                  </div>
                  <div className="fl">
                    {iss.files.slice(0, 10).map((p) => (
                      <div className="dep" key={p} onClick={() => select(model.FMAP[p] ?? null)}>
                        <span
                          className="sw"
                          style={{ background: model.FMAP[p] ? model.colorOf(model.FMAP[p]) : "#999" }}
                        />
                        <span>{p}</span>
                      </div>
                    ))}
                    {iss.files.length > 10 && (
                      <div className="more">… ほか {iss.files.length - 10} 件</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "detail" && sel && (
            <div className="dt">
              <div className="kind">{sel.dir + "/"}</div>
              <h2>{sel.name}</h2>
              {sel.note ? <div className="note">{sel.note}</div> : null}
              {sel.isolated && (
                <div className="flag iso">孤立ファイル：他のファイルを参照しておらず、どこからも参照されていません。</div>
              )}
              {sel.issueTypes.length > 0 && (
                <div className="flag">
                  問題フラグ：
                  {sel.issueTypes.map((t) => ISSUE_LABEL[t as keyof typeof ISSUE_LABEL] ?? t).join("、")}
                </div>
              )}
              <dl>
                <dt>行数</dt>
                <dd>{sel.loc}</dd>
                <dt>出次数 · 依存先</dt>
                <dd>{sel.deps.length}</dd>
                <dt>入次数 · 依存元</dt>
                <dd>{sel.usedBy.length}</dd>
                <dt>行数シェア</dt>
                <dd>{((sel.loc / model.totalLoc) * 100).toFixed(1) + "%"}</dd>
              </dl>
              {depList("依存先", sel.deps)}
              {depList("依存元", sel.usedBy)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
