// Mailbox providers anyone can sign up at. A second key on a company domain
// gets no free checks; on one of these domains each mailbox is its own person.
const LIST = `
gmail.com googlemail.com outlook.com hotmail.com hotmail.co.uk live.com msn.com yahoo.com ymail.com
yahoo.co.uk yahoo.fr yahoo.de icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me
tutanota.com tuta.io fastmail.com hey.com zoho.com gmx.de gmx.net gmx.com web.de t-online.de
mail.ru bk.ru inbox.ru list.ru yandex.ru yandex.com ya.ru qq.com 163.com 126.com naver.com
wp.pl o2.pl interia.pl onet.pl op.pl seznam.cz libero.it orange.fr free.fr laposte.net
`;

const SET: ReadonlySet<string> = new Set(LIST.split(/\s+/).filter(Boolean));

export function isFreeMailDomain(domain: string): boolean {
  return SET.has(String(domain).toLowerCase());
}
