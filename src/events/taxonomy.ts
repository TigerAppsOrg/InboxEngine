/**
 * Event tag taxonomy. Identical to The Forum's `event_tag` Postgres enum so extracted events can
 * be written without translation. Changing it is a breaking change for consumers.
 */
export const EVENT_TAGS = [
  'free food',
  'career',
  'research',
  'academics',
  'tech',
  'entrepreneurship',
  'politics',
  'visual arts',
  'performing arts',
  'literature',
  'culture',
  'music',
  'gaming',
  'athletics',
  'religion',
  'sustainability',
  'outdoors',
  'wellness',
  'community service',
  'speaker event',
  'social event',
  'stem'
] as const;
export type EventTag = (typeof EVENT_TAGS)[number];

export function isEventTag(value: string): value is EventTag {
  return (EVENT_TAGS as readonly string[]).includes(value);
}

/** Keyword evidence per tag, checked against subject + body. Deliberately conservative. */
export const TAG_RULES: Record<EventTag, RegExp> = {
  'free food':
    /\bfree\s+(?:food|pizza|boba|bubble tea|donuts?|doughnuts?|lunch|dinner|breakfast|brunch|snacks?|bagels?|coffee|dessert|ice cream|cookies|tacos|sushi|dumplings)\b|\bfood (?:will be |is )?(?:provided|served)\b|\b(?:dinner|lunch|refreshments|snacks) (?:will be )?(?:provided|served)\b|\bstudy break\b/i,
  career:
    /\b(?:career|recruit(?:ing|ment)?|internships?|job fair|info(?:rmation)? session|coffee chat|resume|interview prep|networking|hiring)\b/i,
  research: /\b(?:research|thesis|junior paper|\bJP\b|lab (?:open house|tour)|symposium|poster session)\b/i,
  academics: /\b(?:lecture|seminar|colloquium|office hours|course|precept|academic|study session|tutoring|workshop on)\b/i,
  tech: /\b(?:hackathon|coding|programming|software|machine learning|\bAI\b|artificial intelligence|computer science|tech talk|developer|web dev|app dev|robotics)\b/i,
  entrepreneurship: /\b(?:startup|start-up|entrepreneur(?:ship|ial)?|founders?|venture|pitch (?:night|competition)|e-club|keller center)\b/i,
  politics: /\b(?:politic(?:s|al)|election|voting|voter|campaign|policy|debate|democra(?:cy|tic)|republican|congress|senator|whig-clio)\b/i,
  'visual arts': /\b(?:art exhibit(?:ion)?|gallery|painting|drawing|sculpture|photography|printmaking|art museum|studio art|ceramics)\b/i,
  'performing arts': /\b(?:theat(?:er|re)|musical|play\b|dance (?:show|performance)|improv|comedy show|stand-up|a cappella|auditions?|recital|performance)\b/i,
  literature: /\b(?:poetry|poems?|book (?:club|talk|launch)|reading series|literary|author talk|creative writing)\b/i,
  culture: /\b(?:cultural|heritage|diwali|lunar new year|holi|eid|hanukkah|diaspora|international students?|culture night|festival)\b/i,
  music: /\b(?:concert|band|orchestra|choir|jazz|dj\b|open mic|a cappella|recital|music)\b/i,
  gaming: /\b(?:game night|board games?|video games?|esports|smash|chess|poker|trivia)\b/i,
  athletics: /\b(?:game vs\.?|match vs\.?|tournament|intramural|athletics|varsity|club sports?|5k|run club|pickup (?:basketball|soccer|game))\b/i,
  religion: /\b(?:worship|prayer|bible study|shabbat|mass\b|chaplain|faith|interfaith|church service|mosque|temple|jummah|religious)\b/i,
  sustainability: /\b(?:sustainab(?:le|ility)|climate|environment(?:al)?|recycling|composting|carbon)\b/i,
  outdoors: /\b(?:hike|hiking|outdoor action|camping|kayak|canoe|picnic|garden(?:ing)?|nature walk|bike ride)\b/i,
  wellness: /\b(?:wellness|mental health|mindfulness|meditation|yoga|self-care|therapy dogs?|stress relief|CPS|UHS)\b/i,
  'community service': /\b(?:volunteer(?:ing)?|community service|service project|donation drive|pace center|mentoring|tutoring kids)\b/i,
  'speaker event': /\b(?:speaker|talk by|keynote|fireside chat|panel(?:ists)?|in conversation with|guest lecture|q&a with)\b/i,
  'social event': /\b(?:party|social|mixer|study break|celebration|formal|gala|meet(?:-| and )greet|hang ?out|karaoke|movie night|screening)\b/i,
  stem: /\b(?:physics|chemistry|biology|mathematics|math\b|engineering|neuroscience|astrophysics|statistics|STEM)\b/i
};

export function tagsFromText(text: string, limit = 4): EventTag[] {
  return EVENT_TAGS.filter((tag) => TAG_RULES[tag].test(text)).slice(0, limit);
}
