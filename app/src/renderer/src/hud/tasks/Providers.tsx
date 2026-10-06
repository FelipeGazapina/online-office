import { useEffect, useState } from 'react';
import type { TaskProvider } from '../../../../shared/protocol.ts';
import { send, useStore } from '../../store.ts';

const NAME: Record<TaskProvider, string> = { linear: 'Linear', cronospark: 'CronoSpark' };

// Where Linear and CronoSpark are connected. A board's sources use these, so the board's settings and the PO computer
// both show them: the credentials belong to the owner, not to a board.
export function ProviderConnections({ only }: { only?: readonly TaskProvider[] }) {
  const connections = useStore((s) => s.taskConnections);
  const [apiKey, setApiKey] = useState('');
  const [userId, setUserId] = useState(connections.cronospark.userId ?? '');
  useEffect(() => setUserId(connections.cronospark.userId ?? ''), [connections.cronospark.userId]);
  const shown = (['linear', 'cronospark'] as const).filter((p) => !only || only.includes(p));
  return (
    <div className="tb-providers">
      <div className="task-connections">
        {shown.map((provider) => {
          const c = connections[provider];
          return (
            <div key={provider} className={`task-connection ${provider === 'linear' ? 'task-connection-linear' : ''}`} data-provider={provider}>
              <span className={`connection-dot ${c.kind}`} />
              <b>{NAME[provider]}</b>
              <small>{c.message ?? (c.kind === 'ready' ? 'Connected' : 'Not connected')}</small>
              {c.kind !== 'ready' && provider === 'linear' && (
                <button type="button" className="btn small" onClick={() => send({ type: 'connect_task_provider', provider })}>
                  Connect Linear
                </button>
              )}
            </div>
          );
        })}
      </div>
      {shown.includes('cronospark') && (
        <form
          className="task-credentials"
          onSubmit={(e) => {
            e.preventDefault();
            send({ type: 'configure_task_provider', provider: 'cronospark', apiKey, userId });
            setApiKey('');
          }}
        >
          <div>
            <b>CronoSpark credentials</b>
            <p className="muted">Saved only on this Mac. Leave the API key blank to keep the saved value or one supplied when the app starts.</p>
          </div>
          <label>
            <span>API key</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={connections.cronospark.hasApiKey ? 'Saved API key' : 'CRONOSPARK_MCP_API_KEY'} autoComplete="new-password" />
          </label>
          <label>
            <span>MCP user ID</span>
            <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="CRONOSPARK_MCP_USER_ID" autoComplete="off" />
          </label>
          <button className="btn primary" type="submit" disabled={!userId.trim() || (!apiKey.trim() && !connections.cronospark.hasApiKey)}>
            Save CronoSpark
          </button>
        </form>
      )}
    </div>
  );
}
