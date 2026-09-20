const SITE_NAMES = new Map([
  ['youtube.com', 'YouTube'],
  ['m.youtube.com', 'YouTube'],
  ['youtu.be', 'YouTube'],
  ['music.youtube.com', 'YouTube Music'],
  ['studio.youtube.com', 'YouTube Studio'],
  ['instagram.com', 'Instagram'],
  ['m.instagram.com', 'Instagram'],
  ['github.com', 'GitHub'],
  ['gist.github.com', 'GitHub Gist'],
  ['x.com', 'X'],
  ['twitter.com', 'X'],
  ['mobile.twitter.com', 'X'],
  ['notion.so', 'Notion'],
  ['notion.com', 'Notion'],
  ['google.com', 'Google'],
  ['google.co.kr', 'Google'],
  ['mail.google.com', 'Gmail'],
  ['drive.google.com', 'Google Drive'],
  ['docs.google.com', 'Google Docs'],
  ['calendar.google.com', 'Google Calendar'],
  ['naver.com', 'Naver'],
  ['m.naver.com', 'Naver'],
  ['search.naver.com', 'Naver'],
  ['daum.net', 'Daum'],
  ['m.daum.net', 'Daum'],
  ['netflix.com', 'Netflix'],
  ['reddit.com', 'Reddit'],
  ['old.reddit.com', 'Reddit'],
  ['facebook.com', 'Facebook'],
  ['m.facebook.com', 'Facebook'],
  ['discord.com', 'Discord'],
  ['chatgpt.com', 'ChatGPT'],
  ['chat.openai.com', 'ChatGPT'],
]);

export function siteName(host) {
  if (typeof host !== 'string') return host;
  const key = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return SITE_NAMES.get(key) ?? host;
}
