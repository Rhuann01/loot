import puppeteer from "puppeteer";

interface CookiesCapturados {
  csrf: string;
  d2id: string;
}

export async function fazerLoginMercadoLivre(
  email: string,
  senha: string,
): Promise<CookiesCapturados> {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.goto("https://www.mercadolivre.com.br/login", {
      waitUntil: "networkidle2",
    });

    await page.type("#user_id", email);
    await page.click("button[type='submit']");

    await page.waitForSelector("#password", { timeout: 10000 });
    await page.type("#password", senha);
    await page.click("button[type='submit']");

    await page.waitForNavigation({ waitUntil: "networkidle2" });

    const cookies = await page.cookies();

    const csrf = cookies.find((c) => c.name === "_csrf");
    const d2id = cookies.find((c) => c.name === "_d2id");

    if (!csrf || !d2id) {
      throw new Error("não foi possível capturar os cookies necessários");
    }

    return { csrf: csrf.value, d2id: d2id.value };
  } finally {
    await browser.close();
  }
}