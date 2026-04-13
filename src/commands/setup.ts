import { loadConfig } from '../core/config.js';
import { connect, exec, disconnect } from '../core/ssh.js';
import { ensureTraefikRunning } from '../core/docker.js';
import { log, spinner } from '../utils/logger.js';

export async function setup() {
  const config = loadConfig();

  log.banner(`Setup: ${config.server.host}`);

  let ssh = await connect(config.server);
  log.success(`Conectado a ${config.server.user}@${config.server.host}`);

  const dockerSpinner = spinner('Verificando Docker...');
  try {
    await exec(ssh, 'sudo docker ps >/dev/null 2>&1');
    dockerSpinner.success('Docker instalado');
  } catch {
    dockerSpinner.update('Instalando Docker...');
    await exec(ssh, 'curl -fsSL https://get.docker.com | sudo sh');
    await exec(ssh, `sudo usermod -aG docker ${config.server.user}`);
    dockerSpinner.success('Docker instalado');

    await disconnect();
    ssh = await connect(config.server);
  }

  const dirSpinner = spinner('Creando directorios...');
  await exec(ssh, 'sudo mkdir -p /opt/deploy && sudo chown $(whoami):$(whoami) /opt/deploy');
  dirSpinner.success('Directorio /opt/deploy creado');

  const firewallSpinner = spinner('Configurando firewall...');
  try {
    await exec(ssh, 'sudo which ufw');
    const sshPort = config.server.port;
    await exec(ssh, `sudo ufw allow ${sshPort}/tcp`);
    await exec(ssh, 'sudo ufw allow 80/tcp');
    await exec(ssh, 'sudo ufw allow 443/tcp');
    await exec(ssh, 'echo "y" | sudo ufw enable 2>/dev/null || true');
    firewallSpinner.success(`Firewall configurado (${sshPort}, 80, 443)`);
  } catch {
    firewallSpinner.success('Firewall: ufw no disponible, saltando');
  }

  const traefikSpinner = spinner('Configurando Traefik...');
  await ensureTraefikRunning(ssh, config.proxy.email);
  traefikSpinner.success('Traefik corriendo con SSL automático');

  await disconnect();

  log.banner('VPS listo');
  log.info('Ahora ejecuta: deploy deploy');
}
