import { join } from 'node:path'

// LaunchAgent for the Sender (spec §3.2): per-user, starts at login,
// restarted by launchd after a crash but not after a clean stop.

export const LAUNCH_AGENT_LABEL = 'local.orca-webhook-bridge.sender'

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function launchAgentPath(home) {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

export function renderLaunchAgentPlist({ nodePath, senderScript, logFile, workingDirectory }) {
  const args = [nodePath, senderScript, '--daemon'].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`
}
