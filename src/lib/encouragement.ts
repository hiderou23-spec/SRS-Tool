/**
 * Short encouragement + a small tip shown when a study session is finished.
 * Rotates so the same message doesn't come back until the list has gone round.
 * Everything stays on the device (a counter in localStorage); nothing is sent.
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
];

const KEY = 'em.encourageIdx';
const LAST_SESSION_KEY = 'em.encourageSession';

function readNum(key: string): number {
  try {
    return Number(localStorage.getItem(key) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * The message and tip for this session. The counter advances once per session,
 * so re-rendering or reopening the same finished session shows the same text.
 */
export function encouragementFor(sessionId: string): { message: string; tip: string } {
  let idx = readNum(KEY);
  try {
    if (localStorage.getItem(LAST_SESSION_KEY) !== sessionId) {
      idx += 1;
      localStorage.setItem(KEY, String(idx));
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
    }
  } catch {
    // Storage unavailable (private mode etc.): fall back to a per-session choice.
    idx = [...sessionId].reduce((a, c) => a + c.charCodeAt(0), 0);
  }
  return pick(idx);
}

/** Deterministic choice for a counter value; consecutive values never repeat. */
export function pick(idx: number): { message: string; tip: string } {
  const i = ((idx % MESSAGES.length) + MESSAGES.length) % MESSAGES.length;
  // Step tips by a different stride so message/tip pairs also vary.
  const j = (((idx * 7) % TIPS.length) + TIPS.length) % TIPS.length;
  return { message: MESSAGES[i], tip: TIPS[j] };
}
