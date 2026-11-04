'use strict';

const { createApp } = require('./src/app');

async function main() {
  let app;
  try {
    app = await createApp();
  } catch (error) {
    console.error('启动失败:', error.message);
    process.exitCode = 1;
    return;
  }

  try {
    const address = await app.listen();
    const displayHost =
      address.address === '0.0.0.0' || address.address === '::'
        ? '127.0.0.1'
        : address.address;
    console.log('');
    console.log('  表情仓已启动');
    console.log(`  http://${displayHost}:${address.port}`);
    console.log(`  环境: ${app.config.isProduction ? 'production' : 'development'}`);
    console.log(`  数据: ${app.config.dbFile}`);
    console.log(`  图片: ${app.config.uploadDir}`);

    if (app.seeded.length > 0) {
      console.log('');
      console.log('  已创建初始账号:');
      for (const account of app.seeded) {
        console.log(`    ${account.username} (${account.role})`);
      }
      if (!app.config.isProduction) {
        console.log('  本地默认密码: 管理员 Admin@123456 / 审核员 Review@123456');
        console.log('  部署前请通过环境变量替换密码。');
      }
    }
    console.log('');
  } catch (error) {
    console.error('监听端口失败:', error.message);
    await app.close();
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在关闭服务…`);
    await app.close().catch((error) => console.error('关闭失败:', error.message));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
