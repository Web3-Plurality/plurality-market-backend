// const puppeteer = require('puppeteer');

// async function scrapeTweetContent(tweetUrl) {
//     // Launch a headless browser
//     const browser = await puppeteer.launch();
//     const page = await browser.newPage();

//     // await page.setViewport({ width: 1920, height: 1080 });

//     // Navigate to the tweet URL
//     await page.goto(tweetUrl);

//     const selector = '#profile-current-wearing-avatar > div.col-sm-6.section-content.profile-avatar-left > div > span'
//     // Wait for the tweet content to load
    
//     await page.waitForSelector(selector);
    
    
//     // Extract the tweet content
//     const tweetContent = await page.evaluate(() => {
//         const selector ='#profile-current-wearing-avatar > div.col-sm-6.section-content.profile-avatar-left > div > span'

//         const tweetElement = document.querySelector('.thumbnail-holder .thumbnail-2d-container img');

//         // console.log(">>", tweetElement.src)
//         // const b = tweetElement.querySelector("")
//     //    if (b) {
        
//     //        console.log(">>>>>>",b.innerText)
//     //    }
//         // const obj = {
//         //     bookmark : bookmark ? bookmark.innerText : 0
//         // }
//         return  tweetElement.src
//     });

//     // Close the browser
//     await browser.close();

//     return tweetContent;
// }

// // URL of the tweet to scrape
// const robloxUrl = 'https://www.roblox.com/users/6083683567/profile';

// // Scrape the tweet content and log it
// scrapeTweetContent(robloxUrl)
//     .then(tweetContent => {

//         console.log('Tweet Content:', tweetContent);
//         if (tweetContent) {
//     //         const data = tweetContent.split("\n")
//     //         console.log(data)
//     //         const obj = {}
//     // for (let i= 0; i < data.length; i++) {
//     //     if (data[i].trim() === "Bookmarks" || data[i].trim() === "Likes" || data[i].trim() === "Quotes" || data[i].trim() === "Reposts") {
            
//     //         obj[data[i].trim()] = data[i - 1].trim();

//     //     }
//     //     else if (data[i].trim() === "From") {
//     //         obj[data[i].trim()] = data[i + 1].trim();
//     //         obj["date"] = data[i + 2].trim();
//     //         obj["Views"] = data[i + 4].trim();

//     //     }

//     //     else if (data[i].trim() === "Follow") {
            
//     //         obj["tweet"] = data[i + 1].trim();
//     //     }

//     //     else if (data[i].trim()[0] === "@") {
            
//     //         obj["username"] = data[i].trim();
//     //     }
        
//     // }

//     // console.log(obj)

//         } else {
//             console.log('Tweet not found or could not be scraped.');
//         }
//     })
//     .catch(error => {
//         console.error('Error scraping tweet:', error);
//     });





const puppeteer = require('puppeteer');

(async () => {
  // Launch a browser instance
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Navigate to the Roblox profile page
  await page.setViewport({ width: 1920, height: 1080 });
  const profileUrl = 'https://www.roblox.com/users/6083683567/profile';
  await page.goto(profileUrl, { waitUntil: 'networkidle2' });

  // Extract the avatar image source
  const robloxInsights = await page.evaluate(() => {
    const imgElement = document.querySelector('.thumbnail-holder .thumbnail-2d-container img');
    const joinElement = document.querySelector('#profile-statistics-container > div > div.section-content > ul > li:nth-child(1) > p.text-lead');
    const placesVisitElement = document.querySelector("#profile-statistics-container > div > div.section-content > ul > li:nth-child(2) > p.text-lead")
    const friendElement = document.querySelector("#profile-header-container > div > div > div > div.header-caption > div.header-details > ul.details-info > li:nth-child(1) > a > span")
    const followerVisitElement = document.querySelector("#profile-header-container > div > div > div > div.header-caption > div.header-details > ul.details-info > li:nth-child(2) > a > span")
    const followingVisitElement = document.querySelector("#profile-header-container > div > div > div > div.header-caption > div.header-details > ul.details-info > li:nth-child(3) > a > span")
    
    
    return {
    avtar: imgElement ? imgElement.src : null,
    joinDate: joinElement ? joinElement.innerText : null,
    placesVisit: placesVisitElement ? placesVisitElement.innerText : null,
    friends: friendElement ? friendElement.innerText : null,
    followers: followerVisitElement ? followerVisitElement.innerText : null,
    following: followingVisitElement ? followingVisitElement.innerText : null,
    }
  });



  console.log('Roblox Insights:', robloxInsights);

  // Close the browser
  await browser.close();
})();

