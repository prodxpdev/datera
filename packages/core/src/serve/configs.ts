/**
 * Per-client connect configuration (spec §8).
 *
 * Generated rather than documented, because the shapes differ per client and a copied
 * snippet with the wrong key is a support conversation. The token, where there is one, is
 * passed in — this module never invents one, and never reads the keychain.
 */

export type ClientId = 'claude-desktop' | 'claude-code' | 'cursor';

export interface ConnectConfig {
  readonly client: ClientId;
  readonly transport: 'stdio' | 'http';
  /** Ready to paste. */
  readonly content: string;
  readonly instructions: string;
}

export interface ConfigOptions {
  readonly workspacePath: string;
  /** Present for the HTTP transport. */
  readonly url?: string | undefined;
  /** Present only when the caller has one. Never fabricated. */
  readonly token?: string | undefined;
  readonly binary?: string | undefined;
}

export function connectConfig(client: ClientId, options: ConfigOptions): ConnectConfig {
  const binary = options.binary ?? 'datera';

  // stdio: the agent launches Datera itself, so there is no listening port and no token
  // to leak. The better default for a single user on one machine.
  if (options.url === undefined) {
    const payload = {
      mcpServers: {
        datera: {
          command: binary,
          args: ['--mcp', '--workspace', options.workspacePath],
        },
      },
    };
    return {
      client,
      transport: 'stdio',
      content: JSON.stringify(payload, null, 2),
      instructions:
        client === 'claude-desktop'
          ? 'Add this to claude_desktop_config.json and restart Claude Desktop.'
          : 'Add this to your MCP client configuration and restart it.',
    };
  }

  const headers = options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` };
  const payload = {
    mcpServers: {
      datera: {
        url: `${options.url.replace(/\/+$/, '')}/mcp`,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    },
  };

  return {
    client,
    transport: 'http',
    content: JSON.stringify(payload, null, 2),
    instructions:
      options.token === undefined
        ? 'Add this to your MCP client configuration. No token is set — anyone who can reach this URL can read the exposed datasets.'
        : 'Add this to your MCP client configuration. Keep the token secret; it grants the access it names.',
  };
}
