/**
 * Short encouragement + a small tip shown when a study session is finished.
 *
 * - A new pair is chosen for every *occasion* (a session at a given number of
 *   answers), so the "goal reached" sheet and the finished screen of the same
 *   session, or a session extended with "あと5分", don't repeat each other.
 *   Re-rendering or reopening the same screen keeps the same text.
 * - Order comes from a shuffled bag: every entry is used once before any comes
 *   back, the order differs each round, and a round never starts with the entry
 *   the previous one ended on.
 * Everything stays on the device (localStorage); nothing is sent.
 */

export const MESSAGES: string[] = [
  '今日の10分が、来月の会議での一言になります。',
  '続けたこと自体が成果です。明日の自分が楽になりました。',
  '完璧でなくて大丈夫。思い出そうとした回数だけ記憶は強くなります。',
  'Again を押せたのは、正直に向き合えた証拠です。',
  '小さな積み重ねは、複利のように効いてきます。',
  '今日覚えた表現を、明日のメールで一度だけ使ってみましょう。',
  '忘れかけた頃に思い出すのが、いちばん記憶に残る学び方です。',
  'ここで止めても大丈夫。残りは明日以降に自動で回ります。',
  '昨日の自分より、確実に一歩前に進みました。',
  '英語は「知っている」から「口から出る」へ。今日もその途中です。',
  '短くても毎日続ける人が、最後に一番伸びます。',
  '会議で言いたかったことが、少しずつ言える形になってきています。',
  'よく頑張りました。今日はここで切り上げても十分です。',
  '思い出せなかった表現ほど、次に出てきた時に定着します。',
  '今日の学習は、未来の自分への投資です。',
  '迷ったら Good。今日も自分のペースで進められました。',
  '1日10分でも、1年で約60時間。大きな差になります。',
  '「前よりすぐ出てくる」と感じたら、それが上達のサインです。',
  'お疲れさまでした。少し休んで、頭を整理する時間にしましょう。',
  '言えた表現は、もう自分の武器です。',
  '学んだことを誰かに一言話すと、記憶はさらに強くなります。',
  'リズムができてきました。この調子で明日も。',
  '難しかった日ほど、記憶には効いています。',
  '今日の積み重ねが、プレゼンの余裕につながります。',
  '忙しい中で時間を作れたこと、それがいちばんの実力です。',
  '記憶は寝ている間に整理されます。今日の分は、今夜しっかり残ります。',
  '一度で覚えなくていい仕組みです。また会える日まで、FSRSが覚えていてくれます。',
  '「あ、これ知ってる」が増えるほど、英語を聞くのが楽しくなります。',
  '今日の自分に小さく拍手。続けるのは才能ではなく選択です。',
  '口に出せた一文は、頭の中だけの知識より何倍も強く残ります。',
  'ペースより継続。今日も記録がひとつ伸びました。',
  '間隔をあけて同じ表現に出会うたびに、記憶は長持ちしていきます。',
  '英語で考える時間が、今日も少し長くなりました。',
  '一つひとつは小さくても、並べると確かな道になっています。',
  'うまくいかなかったカードは、伸びしろが見えたカードです。',
  '学習を終えた今が、いちばん記憶がはっきりしている時間です。',
  '次の会議で一つでも使えたら、それはもう「使える英語」です。',
  'やる気がない日でも開けたなら、それは習慣が育っている証拠です。',
  '今日の分は完了。英語の筋肉が、また少し太くなりました。',
  '覚えた表現の数は、ゆっくりでも確実に増えています。',
  '焦らなくて大丈夫。忘れることも、覚える過程の一部です。',
  '続けている人だけが見られる景色に、少しずつ近づいています。',
  '今日の英語は、ちゃんと未来の自分に届いています。',
  '短い時間に集中できたこと自体が、大きな収穫です。',
  'カードをめくった数だけ、言葉の引き出しが増えました。',
  '明日も同じ時間に開けば、それが一番の近道です。',
  'Hard を選べるのは、自分の理解を正確に見られている証拠です。',
  '今日もやり切りました。あとはFSRSに任せて、ゆっくり休みましょう。',
];

/** Extra lines for the 1-minute mode (mixed in with the general ones). */
export const QUICK_MESSAGES: string[] = [
  '1分でも、ゼロとは大違い。今日も続きがつながりました。',
  '忙しい日に1分。こういう日の継続がいちばん効きます。',
  '短くても開いたことが大事です。明日は少し長めでもOK。',
  '1分の復習で、忘れかけていた表現を救えました。',
  'スキマ時間の1分が、積もると大きな差になります。',
  '「今日はやった」と言える1分です。お疲れさまでした。',
  '習慣は長さより回数。今日も1回、積み上がりました。',
  '1分でも思い出したことで、記憶の期限がしっかり延びました。',
];

export const TIPS: string[] = [
  '例文は声に出して読むと定着しやすくなります。小声でもOKです。',
  '発音ガイドの Level 2 をまねると、ネイティブの話す速さに耳が慣れていきます。',
  '会議の前に、使いたい表現を1つだけ決めておくと実際に口から出やすくなります。',
  'Easy は本当に簡単な時だけに。間隔が一気に伸びるので、甘めの評価は禁物です。',
  '覚えにくい表現は、自分の仕事の場面で例文を1つ作ると定着します（編集画面から追加できます）。',
  '使わない表現は「学習から外す」で整理すると、大事な表現に時間を回せます。',
  '復習が溜まった日は、新しい表現を自動で控えめにしています。無理に増やさなくて大丈夫です。',
  'Speaking では、完璧な英文でなくても意味が通れば Good で構いません。',
  'want to → wanna、going to → gonna など、縮約を知っていると聞き取りが楽になります。',
  't が母音にはさまれると「ラ行」に近い音になります（water →「ウォーダー」）。',
  '単語の最後の t・d は、次が子音だとほとんど聞こえなくなります（next week →「ネクス ウィーク」）。',
  '子音で終わる単語と母音で始まる単語はつながります（take it out →「テイキダウト」）。',
  'to・for・and・of などは会話ではとても弱く短く発音されます。',
  'シャドーイングは、発音ガイドを開いて1文だけでも効果があります。',
  '寝る前の復習は記憶に残りやすいと言われています。',
  'Progress 画面で、Reading と Speaking の伸びを別々に確認できます。',
  '“Let me take a pass at it.”（まず私がやってみます）のような、引き受ける一言を持っておくと会議で便利です。',
  '“That’s a good point, but …” の後に自分の意見を続けると、角を立てずに反論できます。',
  '数字を言う時は “roughly”“about”“just under” を添えると自然になります。',
  '相手の話を確認したい時は “Just to make sure I understand, …” が使えます。',
  'AI生成の例文は「要確認」です。気になる文は確認画面でOKか編集を。',
  '思い出す前に答えを見ないのがコツ。数秒考えるだけで記憶は強くなります。',
  '同じ表現でも例文は毎回変わります。文ではなく意味で覚えるためです。',
  '目標の記憶率は Settings で変えられます。上げると復習が増え、下げると減ります。',
  '時間がない日はホームの「1分だけ」を。続けることが何より大切です。',
  'Progress の「覚えた表現と今後の予測」で、このペースだといつ何語になるか確認できます。',
  '学習中の表現が多い日は、新しい表現を増やすより復習を優先すると定着が早まります。',
  '会議で聞き取れなかったら “Sorry, could you say that again?” で十分。聞き返すのは失礼ではありません。',
  '話す前に一呼吸おきたい時は “Let me think about that for a second.” が便利です。',
  '“I’d suggest …” は “You should …” より柔らかく提案できます。',
  '話題を変えたい時は “On a related note, …” や “Moving on to …” が使えます。',
  'メールの締めは “Let me know if you have any questions.” が万能です。',
  '同意を示す時は “Exactly.”“That makes sense.” など短い相づちが自然です。',
  '強く言い切りたくない時は “I think …”“It seems like …” で和らげられます。',
  '-ed の発音は3種類。worked は「ト」、played は「ド」、wanted は「イド」に近くなります。',
  'can は弱く「クン」、can’t ははっきり「キャーント」。強さで聞き分けられます。',
  'did you → 「ディジュ」、would you → 「ウッジュ」のように、y の前の d はつながって音が変わります。',
  'of は会話でほぼ「ア」になります（a lot of →「アラダ」）。',
  '文の中で強く読むのは名詞・動詞・形容詞などの内容語。リズムをつかむと一気に聞きやすくなります。',
  'him・her・them は会話では h や th が落ちて「イム」「アー」「エム」のように聞こえます。',
  '-ing の最後は会話で「イン」になりがちです（going →「ゴーイン」）。',
  '新しい表現は、意味を見た後に自分の体験で一文作ると記憶の手がかりが増えます。',
  '似た表現を同じ日に詰め込むと混ざりやすくなります。分散して覚えるのがおすすめです。',
  '思い出すのに時間がかかったら、正解でも Hard を選ぶと適切な間隔になります。',
  '取り込み直しても重複は増えません。reminDOで追加した分だけ取り込めます。',
  '週に一度バックアップを取っておくと、iPhoneのデータ削除にも安心です。',
  '例文を聞いて意味がすぐ浮かべば、その表現は「読める」から「聞ける」に近づいています。',
  '同じ例文を3回続けて言えたら、口がその形を覚え始めています。',
];

const SHOWN_KEY = 'em.encourageShown';
const bagKey = (name: string) => `em.bag.${name}`;

/** Minimal storage interface (localStorage in the app, a map in tests). */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Bag {
  n: number;
  order: number[];
  pos: number;
}

function shuffled(n: number, rand: () => number, avoidFirst?: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (n > 1 && avoidFirst !== undefined && a[0] === avoidFirst) {
    const k = 1 + Math.floor(rand() * (n - 1));
    [a[0], a[k]] = [a[k], a[0]];
  }
  return a;
}

/**
 * Next index from a persistent shuffled bag of size n. Each index appears once
 * per round; a new round never starts with the index the last one ended on.
 */
export function nextFromBag(store: KV, name: string, n: number, rand: () => number = Math.random): number {
  let bag: Bag | null = null;
  try {
    bag = JSON.parse(store.getItem(bagKey(name)) ?? 'null');
  } catch {
    bag = null;
  }
  if (!bag || bag.n !== n || !Array.isArray(bag.order) || bag.order.length !== n) {
    bag = { n, order: shuffled(n, rand), pos: 0 };
  } else if (bag.pos >= n) {
    bag = { n, order: shuffled(n, rand, bag.order[n - 1]), pos: 0 };
  }
  const idx = bag.order[bag.pos];
  bag.pos++;
  store.setItem(bagKey(name), JSON.stringify(bag));
  return idx;
}

export interface Occasion {
  sessionId: string;
  /** Answers so far in the session; a later end screen gets a new pair. */
  answered: number;
  quick?: boolean;
}

/** Share of 1-minute sessions that get a 1-minute-specific message. */
const QUICK_SHARE = 0.5;

export function encouragementWith(
  store: KV,
  occ: Occasion,
  rand: () => number = Math.random,
): { message: string; tip: string } {
  const key = `${occ.sessionId}:${occ.answered}`;
  try {
    const prev = JSON.parse(store.getItem(SHOWN_KEY) ?? 'null');
    if (prev && prev.key === key && typeof prev.message === 'string' && typeof prev.tip === 'string') {
      return { message: prev.message, tip: prev.tip };
    }
  } catch {
    /* ignore broken value */
  }
  const message =
    occ.quick && rand() < QUICK_SHARE
      ? QUICK_MESSAGES[nextFromBag(store, 'quick', QUICK_MESSAGES.length, rand)]
      : MESSAGES[nextFromBag(store, 'messages', MESSAGES.length, rand)];
  const tip = TIPS[nextFromBag(store, 'tips', TIPS.length, rand)];
  store.setItem(SHOWN_KEY, JSON.stringify({ key, message, tip }));
  return { message, tip };
}

/** The message and tip for this end screen. */
export function encouragementFor(occ: Occasion): { message: string; tip: string } {
  try {
    return encouragementWith(localStorage, occ);
  } catch {
    // Storage unavailable (private mode etc.): a random pair.
    return {
      message: MESSAGES[Math.floor(Math.random() * MESSAGES.length)],
      tip: TIPS[Math.floor(Math.random() * TIPS.length)],
    };
  }
}
