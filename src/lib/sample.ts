/**
 * A tiny optional sample deck that demonstrates the full card structure
 * (3 examples, pronunciation levels, katakana, IPA). All content is AI-written
 * and therefore stored as unverified / 要確認. It is NOT the Phase 2 generator.
 */
import { db } from '../db/db';
import type { Example, Expression } from '../db/types';
import { makeCards, refreshDuplicateGroups } from '../import/importer';
import { normalizeKey, classifyKind } from '../import/clean';
import { nowIso, uid } from './util';

type Ex = Omit<Example, 'id' | 'origin' | 'status'>;

const SAMPLES: { text: string; meaning: string; prompt: string; importance: number; category: Expression['category']; examples: Ex[] }[] = [
  {
    text: 'hammer out',
    meaning: '（協議して）合意をまとめる、詳細を詰める',
    prompt: '会議で：金曜日までに詳細を「詰める」必要がある',
    importance: 90,
    category: 'phrasal_verb',
    examples: [
      {
        kind: 'business',
        en: 'We need to hammer out the details before Friday.',
        ja: '金曜日までに詳細を詰める必要があります。',
        pronunciation: {
          level1: { ipa: '/wi niːd tə ˈhæmɚ aʊt ðə ˈdiːteɪlz bɪˈfɔːr ˈfraɪdeɪ/', katakana: 'ウィ ニード トゥ ハマー アウト ザ ディーテイルズ ビフォー フライデイ' },
          level2: { text: 'We nee-tuh hamme-rout the details b’fore Friday.', katakana: 'ウィ ニートゥ ハマラウッ ザ ディーテイルズ ブフォー フライデイ', ipa: '/wi ˈniːtə ˈhæmɚɹaʊʔ ðə ˈdiːteɪlz bəˈfɔɹ ˈfɹaɪdeɪ/' },
          level3: { text: 'We needa hamme-rou’ the details b’fore Friday.', katakana: 'ウィ ニーダ ハマラウッ ダ ディーテイルズ ブフォ フライデイ' },
          notes: 'need to: d が脱落し「ニートゥ」/ 速いと弾音化して「ニーダ」。hammer out: r と母音が連結（ハマラウ）。out の t は声門閉鎖で飲み込まれる。',
          origin: 'sample',
          status: 'needs_review',
        },
      },
      { kind: 'alternative', en: "Let's hammer out an agreement.", ja: '合意内容を詰めましょう。' },
      { kind: 'daily', en: 'We still need to hammer out our plans.', ja: 'まだ計画を具体的に決める必要があります。' },
    ],
  },
  {
    text: 'flesh out',
    meaning: '（案・計画などに）肉付けする、具体化する',
    prompt: '提案書をもう少し「具体化して」ほしいと頼む',
    importance: 85,
    category: 'phrasal_verb',
    examples: [
      {
        kind: 'business',
        en: 'Can you flesh out the proposal a bit more?',
        ja: '提案をもう少し具体化してもらえますか？',
        pronunciation: {
          level1: { ipa: '/kæn juː flɛʃ aʊt ðə prəˈpoʊzəl ə bɪt mɔːr/', katakana: 'キャン ユー フレッシュ アウト ザ プロポウザル ア ビット モア' },
          level2: { text: 'C’n you flesh-out the proposal a bit more?', katakana: 'クニュ フレッシャウッ ザ プロポウザル アビッ モア', ipa: '/kənjə ˈflɛʃaʊʔ ðə pɹəˈpoʊzəl ə bɪʔ ˈmɔɹ/' },
          level3: { text: 'C’nya flesha’ th’ proposal a bi’ more?', katakana: 'キニャ フレッシャッ ザ プロポウゾ アビッモア' },
          notes: 'Can you は弱形 /kən/ + /jə/。flesh out は sh と母音が連結。bit の t は次の m の前で声門閉鎖。',
          origin: 'sample',
          status: 'needs_review',
        },
      },
      { kind: 'daily', en: "I haven't fleshed out the idea yet.", ja: 'そのアイデアはまだ具体的に詰めていません。' },
      { kind: 'alternative', en: 'The characters need to be fleshed out.', ja: '登場人物にもっと深みを持たせる必要がある。' },
    ],
  },
  {
    text: 'push back',
    meaning: '反対する・異議を唱える／（予定を）後ろ倒しにする',
    prompt: 'そのスケジュール案に「異議を唱えたい」と丁寧に言う',
    importance: 92,
    category: 'business',
    examples: [
      {
        kind: 'business',
        en: "I'd like to push back on that timeline.",
        ja: 'そのスケジュールには異議を唱えたいです。',
        pronunciation: {
          level1: { ipa: '/aɪd laɪk tə pʊʃ bæk ɑn ðæt ˈtaɪmlaɪn/', katakana: 'アイド ライク トゥ プッシュ バック オン ザット タイムライン' },
          level2: { text: 'I’d like tuh push ba-kon tha’ timeline.', katakana: 'アイド ライクトゥ プッシュ バコン ザッ タイムライン', ipa: '/aɪd ˈlaɪktə pʊʃ ˈbækɑn ðæʔ ˈtaɪmlaɪn/' },
          level3: { text: 'I’d like-uh push ba-kon tha’ timeline.', katakana: 'アイ ライカ プッシュ バコン ザッタイムライン' },
          notes: 'back on は k と母音が連結（バコン）。that の t は次の t と重なり1回分になる。like to は速いと「ライカ」に近づく。',
          origin: 'sample',
          status: 'needs_review',
        },
      },
      { kind: 'alternative', en: "We had to push back the launch by two weeks.", ja: 'ローンチを2週間延期せざるを得ませんでした。' },
      { kind: 'daily', en: "Don't be afraid to push back if you disagree.", ja: '納得できないなら遠慮せず反論していいよ。' },
    ],
  },
  {
    text: 'align on',
    meaning: '（〜について）認識・方針をすり合わせる、合意する',
    prompt: '終わる前に「次のステップについて認識を合わせよう」と言う',
    importance: 88,
    category: 'business',
    examples: [
      {
        kind: 'business',
        en: "Let's align on the next steps before we wrap up.",
        ja: '終わる前に、次のステップについて認識を合わせましょう。',
        pronunciation: {
          level1: { ipa: '/lɛts əˈlaɪn ɑn ðə nɛkst stɛps bɪˈfɔːr wi ræp ʌp/', katakana: 'レッツ アライン オン ザ ネクスト ステップス ビフォー ウィ ラップ アップ' },
          level2: { text: 'Let’s uh-lie-non the nex’ steps b’fore we wra-pup.', katakana: 'レッツ アライノン ザ ネクステップス ブフォー ウィ ラパップ', ipa: '/lɛts əˈlaɪnɑn ðə ˈnɛkstɛps bəˈfɔɹ wi ˈɹæpʌp/' },
          notes: 'align on は n と母音が連結（アライノン）。next steps の t が脱落。wrap up は p と母音が連結（ラパップ）。これ以上崩れた形は一般的ではないため Level 3 は省略。',
          origin: 'sample',
          status: 'needs_review',
        },
      },
      { kind: 'alternative', en: 'We need to align on priorities first.', ja: 'まず優先順位について合意する必要があります。' },
      { kind: 'daily', en: "Let's align on where we're meeting.", ja: 'どこで待ち合わせるか決めておこう。' },
    ],
  },
];

export async function addSampleDeck(): Promise<number> {
  const ts = nowIso();
  const existing = new Set((await db.expressions.toArray()).map((e) => e.normalized));
  const exprs: Expression[] = [];
  for (const s of SAMPLES) {
    const normalized = normalizeKey(s.text);
    if (existing.has(normalized)) continue;
    exprs.push({
      id: uid(),
      text: s.text,
      normalized,
      meaning: s.meaning,
      productionPrompt: s.prompt,
      notes: '',
      kind: classifyKind(s.text),
      ai: { category: s.category!, importance: s.importance, rationale: 'サンプル（AI作成・未検証）', model: 'sample', generatedAt: ts },
      examples: s.examples.map((e) => ({ ...e, id: uid(), origin: 'ai', status: 'unverified' })),
      tags: ['sample'],
      suspended: false,
      usedInRealLife: [],
      createdAt: ts,
      updatedAt: ts,
    });
  }
  await db.transaction('rw', db.expressions, db.cards, db.duplicates, async () => {
    await db.expressions.bulkAdd(exprs);
    await db.cards.bulkAdd(exprs.flatMap((e) => makeCards(e.id)));
    await refreshDuplicateGroups();
  });
  return exprs.length;
}
