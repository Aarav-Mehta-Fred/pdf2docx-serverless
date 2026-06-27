const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const server = spawn('npx', ['http-server', '-p', '8080'], { shell: true });

setTimeout(async () => {
    try {
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        page.on('console', msg => console.log('LOG:', msg.text()));
        page.on('pageerror', err => console.log('ERR:', err.message));
        
        await page.goto('http://localhost:8080/index.html', { waitUntil: 'networkidle0' });
        await browser.close();
    } catch(e) {
        console.error(e);
    } finally {
        server.kill();
        process.exit(0);
    }
}, 3000);
