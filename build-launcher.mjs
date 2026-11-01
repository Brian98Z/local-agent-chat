import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Build requires Windows .NET Framework C# compiler.');
const root = dirname(fileURLToPath(import.meta.url));
const compiler = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
if (!existsSync(compiler)) throw new Error('Missing .NET Framework 4.x compiler: ' + compiler);
const iconBuild = spawnSync('powershell.exe', ['-NoProfile', '-File', join(root, 'build-icon.ps1')], { stdio: 'inherit', cwd: root });
if (iconBuild.error) throw iconBuild.error;
if (iconBuild.status !== 0) process.exit(iconBuild.status || 1);
const output = join(root, 'LocalAgentChat.exe');
const wpf = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/WPF');
const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Net.Http.dll', '/r:System.Web.Extensions.dll', '/r:System.Xaml.dll', '/r:' + join(wpf, 'WindowsBase.dll'), '/r:' + join(wpf, 'PresentationCore.dll'), '/r:' + join(wpf, 'PresentationFramework.dll'), '/r:' + join(wpf, 'WindowsFormsIntegration.dll'), '/win32manifest:' + join(root, 'launcher.manifest'), '/win32icon:' + join(root, 'chat-icon.ico'), '/out:' + output, join(root, 'Launcher.cs'), join(root, 'ChatForm.cs')], { stdio: 'inherit', cwd: root });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log('Built: ' + output);
