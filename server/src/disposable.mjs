// Domains that hand out throwaway inboxes. A signup from one of these gets no
// free credits. Short on purpose: the DNS tier already refuses domains that
// cannot receive mail, and a human reads every signup ping.
const LIST = `
10minutemail.com 10minutemail.net 10minemail.com 20minutemail.com 33mail.com anonbox.net anonymbox.com
binkmail.com bobmail.info burnermail.io byom.de chammy.info crazymailing.com deadaddress.com despam.it
dispostable.com dropmail.me emailondeck.com emailtemporanea.com fakeinbox.com fakemail.net filzmail.com
getairmail.com getnada.com guerrillamail.com guerrillamail.net guerrillamail.org guerrillamailblock.com
harakirimail.com inboxkitten.com incognitomail.org jetable.org koszmail.pl kurzepost.de mailcatch.com
maildrop.cc mailexpire.com mailinator.com mailinator.net mailnesia.com mailnull.com mailsac.com
mailtemp.info meltmail.com mintemail.com mohmal.com moakt.com mytemp.email nowmymail.com
owlymail.com pokemail.net proxymail.eu sharklasers.com spam4.me spamgourmet.com spambox.us
spamex.com spamfree24.org spamhereplease.com temp-mail.org temp-mail.io tempail.com tempinbox.com
tempmail.com tempmail.net tempmailaddress.com tempmailo.com tempr.email throwawaymail.com
tmail.ws tmpmail.net tmpmail.org trashmail.com trashmail.de trashmail.net trashmail.me
wegwerfmail.de wegwerfmail.net wegwerfmail.org yopmail.com yopmail.fr yopmail.net zetmail.com
`;

const SET = new Set(LIST.split(/\s+/).filter(Boolean));

export function isDisposableDomain(domain) {
  const d = String(domain).toLowerCase();
  if (SET.has(d)) return true;
  // subdomains of a listed domain
  const parts = d.split(".");
  for (let i = 1; i < parts.length - 1; i++) if (SET.has(parts.slice(i).join("."))) return true;
  return false;
}
