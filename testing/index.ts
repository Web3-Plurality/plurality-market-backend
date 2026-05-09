import  puppeteer from 'puppeteer';
import analyzeTweet from "./grok";
import { Insights } from "./classes";


(async () => {
  // Launch Puppeteer browser
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--window-size=1280,800']
  });
  const page = await browser.newPage();

  // Set the viewport size
  await page.setViewport({ width: 1280, height: 800 });

  // Navigate to the actual website where you want to extract data
  await page.goto('https://twitter.com/EstoniaInvest/status/1786379290386256287'); // Replace with an actual tweet URL

  // Wait for the element to load on the page
  // await page.waitForSelector('div[data-testid="tweetText"]');
  await page.waitForSelector('article[data-testid="tweet"]');

  // Extract inner text of the element with data-testid="tweetText"
  const innerText = await page.evaluate(() => {
    const tweetElement = document.querySelector('div[data-testid="tweetText"]');
    const element = document.querySelector('article[data-testid="tweet"]');



    if (element) {
      const data = element?.innerText.split("\n")
      const obj = {}
      let i  = 0
      while (i < data.length) {
        if (data[i].trim() === "Bookmarks" || data[i].trim() === "Likes" || data[i].trim() === "Quotes" || data[i].trim() === "Reposts") {
          obj[data[i].trim()] = data[i - 1].trim();
          i += 1
        }
        else if (data[i].trim() === "Views") {
          obj[data[i].trim()] = data[i - 1].trim();
          obj["date"] = data[i - 3].trim();
  
          i += 1
        }
        else if (data[i].trim()[0] === "@") {

          obj["username"] = data[i].trim();
          i += 1
        }
        else {
          i += 1
        }

      }

      // const insights  =  tweetElement ? await  analyzeTweet(tweetElement.innerText) : {}
      return {
        ...obj,
        "tweetText": tweetElement ? tweetElement?.innerText : null,
      }

    }


    else {
      return {}
    }



  });

  
  const insights  = innerText?.tweetText ? await analyzeTweet(innerText?.tweetText) : {};
 
  const insight = new Insights(
    insights.Interests,
    insights.Hashtags,
    insights.ExtraTags
  );
  console.log(insight)
  // console.log({...innerText,"insights":insights})

  await browser.close();
})();
