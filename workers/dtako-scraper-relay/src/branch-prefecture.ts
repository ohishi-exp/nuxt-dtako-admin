/**
 * 所属 (営業所) → 都道府県の解決 (pure、Refs #409 Phase 2)。
 *
 * 最低賃金は就業地の都道府県で決まるので、乗務員がどの拠点に属するかを都道府県へ
 * 落とす必要がある。社員マスタ (`employee_attrs.branch`) は「拠点 職種」形式で、
 * 本番には 31 種ある (`本社  乗務員` / `帯広 乗務員(トレーラ-)` / `北九州営業所乗務員`)。
 *
 * **キーは前方一致で引く。** `本社` を 1 つ登録すれば `本社 乗務員`・`本社 修理`・
 * 今後増える職種まで覆える。職種が増えるたびに未マッピングが生まれて最低賃金の
 * 判定から静かに抜け落ちる、という運用事故を防ぐのが狙い。完全一致も前方一致の
 * 一種なので、theearth の事業所名で登録済みの旧キー (Refs #253) はそのまま効く。
 *
 * **都道府県は推定しない。** 「本社」が長崎県であるように、拠点名から県は決まらない
 * (2026-07-25 ユーザー確認)。このモジュールがやるのは*グループ候補の提示*までで、
 * どの県かは必ず人が選ぶ。未設定は未設定のまま返す — 誤った県で最低賃金割れを
 * 判定するより、判定しないほうが安全。
 */

/** 全角スペースを半角へ倒し、連続空白を 1 つに潰して trim する。
 * 給与大臣の所属名には `本社  乗務員` (全角2つ) と `本社 乗務員` の揺れが実在する。 */
export function normalizeBranchLabel(text: string): string {
  return text.replace(/[\s　]+/g, " ").trim();
}

/** 文字列の安定した昇順比較。`localeCompare` は使わない — ICU の照合順が
 * Windows と Linux で逆転し、CI だけ落ちる事故を踏んだことがある。 */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** `branch` が拠点キー `prefix` の配下か (空白揺れを正規化した前方一致)。 */
export function isBranchUnder(prefix: string, branch: string): boolean {
  const key = normalizeBranchLabel(prefix);
  return key !== "" && normalizeBranchLabel(branch).startsWith(key);
}

export interface BranchPrefectureLookup {
  /** 引けた都道府県。未マッピングなら null。 */
  prefecture: string | null;
  /** 一致した `branchToPrefecture` のキー (未マッピングなら null)。 */
  matchedKey: string | null;
}

/**
 * 所属名から都道府県を引く。複数のキーが前方一致したら**最長のキー**を採る
 * (`本社` と `本社 乗務員` が両方あれば後者)。
 */
export function resolveBranchPrefecture(
  branchToPrefecture: Record<string, string>,
  branch: string,
): BranchPrefectureLookup {
  const target = normalizeBranchLabel(branch);
  let matchedKey: string | null = null;
  let prefecture: string | null = null;
  for (const [key, pref] of Object.entries(branchToPrefecture)) {
    const normalizedKey = normalizeBranchLabel(key);
    if (normalizedKey === "" || !target.startsWith(normalizedKey)) continue;
    if (matchedKey === null || normalizedKey.length > normalizeBranchLabel(matchedKey).length) {
      matchedKey = key;
      prefecture = pref;
    }
  }
  return { prefecture, matchedKey };
}

/**
 * 乗務員CD → その月に適用する所属 (社員マスタ、月末時点) の対応を作る。
 *
 * 最低賃金は就業地の県で決まるので、theearth の事業所名ではなく**社員マスタの所属**を
 * 正とする (Refs #409 Phase 3)。theearth 側の事業所名 (`大石運輸倉庫㈱　本社営業所`) は
 * 拠点キー (`本社`) と噛み合わないため、これが無いと最低賃金を引けない。
 *
 * 乗務員CD が未設定の社員と、月末時点で所属履歴が無い社員は落とす。
 */
export function branchByDriverCdAt<A extends { effectiveFrom: string; branch: string | null }>(
  employees: readonly { driverCd: string | null; attrs: A[] }[],
  yearMonth: string,
  resolveAt: (attrs: A[], ym: string) => { branch: string | null } | null,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of employees) {
    if (!e.driverCd) continue;
    const attr = resolveAt(e.attrs, yearMonth);
    if (!attr?.branch) continue;
    out.set(e.driverCd, attr.branch);
  }
  return out;
}

export interface BranchGroupSuggestion {
  /** 提案するキー (前方一致で使う)。 */
  prefix: string;
  /** このキーが覆う所属名 (正規化前の原文、昇順)。 */
  branches: string[];
}

/** 2 件以上で共有される前方一致の最短長。1 文字だと無関係な拠点まで巻き込む。 */
const MIN_SHARED_PREFIX = 2;

/**
 * 所属名の一覧から、前方一致キーの候補をまとめる。
 *
 * - 空白があるものは**第 1 トークン**を拠点とみなす (`帯広 乗務員(トレーラ-)` → `帯広`)
 * - 空白が無いものは、**2 件以上が共有する前方一致**でまとめる。件数が多いものを
 *   優先し、同数なら長いほうを採る (`北九州営業所{一般管理,乗務員,乗務員トレ}` →
 *   `北九州営業所`)。どれとも共有しなければそれ自身が 1 グループ
 *
 * あくまで**候補**で、画面で人が直せる前提。県はここでは決めない。
 */
export function suggestBranchGroups(branches: readonly string[]): BranchGroupSuggestion[] {
  const groups = new Map<string, Set<string>>();
  const add = (prefix: string, branch: string) => {
    const set = groups.get(prefix) ?? new Set<string>();
    set.add(branch);
    groups.set(prefix, set);
  };

  const spaceless: string[] = [];
  for (const branch of branches) {
    const normalized = normalizeBranchLabel(branch);
    if (normalized === "") continue;
    const space = normalized.indexOf(" ");
    if (space > 0) add(normalized.slice(0, space), branch);
    else spaceless.push(branch);
  }

  // 空白なしは、既に拠点として立っているキーに前方一致するならそこへ寄せる
  const remaining: string[] = [];
  for (const branch of spaceless) {
    const normalized = normalizeBranchLabel(branch);
    let best: string | null = null;
    for (const prefix of groups.keys()) {
      if (normalized.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix;
    }
    if (best !== null) add(best, branch);
    else remaining.push(branch);
  }

  // 残りは「2 件以上が共有する前方一致」でまとめる (件数優先、同数なら長いほう)
  let pool = remaining;
  while (pool.length > 0) {
    const counts = new Map<string, number>();
    for (const branch of pool) {
      const normalized = normalizeBranchLabel(branch);
      for (let len = MIN_SHARED_PREFIX; len <= normalized.length; len++) {
        const prefix = normalized.slice(0, len);
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
    }
    let bestPrefix: string | null = null;
    let bestCount = 1;
    for (const [prefix, count] of counts) {
      if (count < 2) continue;
      if (count > bestCount || (count === bestCount && bestPrefix !== null && prefix.length > bestPrefix.length)) {
        bestPrefix = prefix;
        bestCount = count;
      }
    }
    if (bestPrefix === null) {
      // 共有する前方一致が無いものは、それ自身を 1 グループにする
      for (const branch of pool) add(normalizeBranchLabel(branch), branch);
      break;
    }
    const matched = pool.filter((b) => normalizeBranchLabel(b).startsWith(bestPrefix!));
    for (const branch of matched) add(bestPrefix, branch);
    pool = pool.filter((b) => !normalizeBranchLabel(b).startsWith(bestPrefix!));
  }

  return [...groups.entries()]
    .map(([prefix, set]) => ({ prefix, branches: [...set].sort(compareText) }))
    .sort((a, b) => compareText(a.prefix, b.prefix));
}
