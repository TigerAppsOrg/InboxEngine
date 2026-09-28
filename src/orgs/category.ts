export function classifyCategory(subject: string, body: string) {
  const text = `${subject}\n${body.slice(0, 12000)}`;
  const rules: [string, RegExp][] = [
    [
      'Free food',
      /free\s+(food|pizza|boba|donuts|doughnuts|lunch|dinner|snacks)|food is provided|leftover|food.*(?:available|up for grabs)/i
    ],
    [
      'Opportunities',
      /application|apply\b|internship|hiring|recruit|fellowship|paid study|paid research|job\b/i
    ],
    [
      'Arts & culture',
      /\bconcert|\baudition|\btheat(?:er|re)|\bdance\b|orchestra|a cappella|art exhibit|poetry|film screening|museum/i
    ],
    [
      'Academics',
      /lecture|seminar|colloquium|research|professor|department|symposium|office hours|course\b/i
    ],
    [
      'Events & socials',
      /rsvp|party|social|celebrat|join us|tonight|open house|picnic|workshop|tournament|game night|meeting/i
    ]
  ];
  return (
    rules.find(([, pattern]) => pattern.test(subject))?.[0] ??
    rules.find(([, pattern]) => pattern.test(text))?.[0] ??
    'Campus life'
  );
}
