import { useState } from 'react';
import type { SessionInfo } from '../collab/collab-session';
import { JoinScreen } from './JoinScreen';
import { sessionStore } from './session-store';
import { Workspace } from './Workspace';

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(() => sessionStore.load());

  const join = (info: SessionInfo) => {
    sessionStore.save(info);
    window.location.hash = `${info.user.tenantId}/${info.roomId}`;
    setSession(info);
  };
  const leave = () => {
    sessionStore.clear();
    setSession(null);
  };

  return session ? (
    <Workspace key={session.token} info={session} onLeave={leave} />
  ) : (
    <JoinScreen onJoin={join} />
  );
}
