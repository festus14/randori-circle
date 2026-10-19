// Shared client-address helpers for rate limiting. The platform proxy sets
// the first X-Forwarded-For entry; the socket address is the local fallback.

export function clientAddress(req){
  return String(req?.headers?.['x-forwarded-for']||req?.socket?.remoteAddress||'unknown')
    .split(',')[0].trim().slice(0,128)||'unknown';
}

function expandIpv6(value){
  const address=value.replace(/^\[|\]$/g,'').split('%')[0].toLowerCase();
  if(!/^[0-9a-f:.]+$/.test(address)||!address.includes(':')) return null;
  const halves=address.split('::');
  if(halves.length>2) return null;
  const parse=part=>part?part.split(':'):[];
  let head=parse(halves[0]);
  let tail=parse(halves[1]);
  // An embedded IPv4 tail (e.g. ::ffff:192.0.2.1) occupies two groups.
  const last=(tail.length?tail:head).at(-1)||'';
  if(last.includes('.')){
    const octets=last.split('.').map(Number);
    if(octets.length!==4||octets.some(octet=>!Number.isInteger(octet)||octet<0||octet>255)) return null;
    const groups=[(octets[0]<<8|octets[1]).toString(16),(octets[2]<<8|octets[3]).toString(16)];
    if(tail.length) tail=[...tail.slice(0,-1),...groups]; else head=[...head.slice(0,-1),...groups];
  }
  const missing=8-head.length-tail.length;
  if(halves.length===1?missing!==0:missing<1) return null;
  const groups=[...head,...Array(halves.length===2?missing:0).fill('0'),...tail];
  if(groups.length!==8||groups.some(group=>!/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group=>group.padStart(4,'0'));
}

/**
 * Rate-limit identity for a client address. IPv6 clients usually control a
 * whole /64, so they are keyed by that prefix; IPv4-mapped IPv6 collapses to
 * the IPv4 address. Anything unparseable is used verbatim (bounded).
 */
export function rateLimitAddress(value){
  const address=String(value||'unknown').trim().slice(0,128)||'unknown';
  const groups=expandIpv6(address);
  if(!groups) return address;
  if(groups.slice(0,5).every(group=>group==='0000')&&groups[5]==='ffff'){
    const high=parseInt(groups[6],16);
    const low=parseInt(groups[7],16);
    return `${high>>8}.${high&255}.${low>>8}.${low&255}`;
  }
  return `${groups.slice(0,4).join(':')}::/64`;
}
