import { useSyncExternalStore } from 'react';
import type { CollabSession } from '../collab/collab-session';

export function PresenceList({ session }: { session: CollabSession }) {
  const peers = useSyncExternalStore(session.presence.subscribe, session.presence.getPeers);
  const me = session.info.user;
  // One avatar per person even if they have several tabs open.
  const others = [...new Map(peers.map((p) => [p.user.id, p.user])).values()].filter(
    (u) => u.id !== me.id,
  );
  const everyone = [{ id: me.id, name: me.name, color: session.info.color, isMe: true }, ...others];

  return (
    <ul className="presence" aria-label="People on this board" data-testid="presence">
      {everyone.map((user) => (
        <li
          key={user.id}
          title={'isMe' in user ? `${user.name} (you)` : user.name}
          style={{ background: user.color }}
        >
          {initials(user.name)}
        </li>
      ))}
      <li className="count">{everyone.length} online</li>
    </ul>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}
