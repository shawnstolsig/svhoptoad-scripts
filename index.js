const { GoogleSpreadsheet } = require("google-spreadsheet");
const { google_spreadsheet_id, client_email, private_key } = require("./config.json");
const spreadsheet = new GoogleSpreadsheet(google_spreadsheet_id);
const axios = require('axios')
const cron = require('node-cron');

async function main(){

    // setup Google Sheet
    await spreadsheet.useServiceAccountAuth({
        client_email,
        private_key
    });
    await spreadsheet.loadInfo();

    // get all location ids
    const locationsSheet = await spreadsheet.sheetsByTitle['Locations']
    await locationsSheet.loadCells('A:A')
    let locationIds = []
    for(let i = 0; i < locationsSheet.rowCount; i++){
        locationIds.push(locationsSheet.getCell(i,0).value)
    }
    locationIds = [...new Set(locationIds)].filter(cell => cell)

    // get all blog ids
    const blogSheet = await spreadsheet.sheetsByTitle['Blog Posts']
    await blogSheet.loadCells('A:A')
    let blogIds = []
    for(let i = 0; i < blogSheet.rowCount; i++){
        blogIds.push(blogSheet.getCell(i,0).value)
    }
    blogIds = [...new Set(blogIds)].filter(cell => cell)

    // get all phone numbers
    const phoneSheet = await spreadsheet.sheetsByTitle['SMS Subscribers']
    await phoneSheet.loadCells('A:A')
    let phoneNumbers = []
    for(let i = 0; i < phoneSheet.rowCount; i++){
        phoneNumbers.push(phoneSheet.getCell(i,0).value)
    }
    phoneNumbers = [...new Set(phoneNumbers)].filter(cell => cell)

    // get info from Predict Wind
    const { data: { route: existingLocations } } = await axios.get('https://forecast.predictwind.com/vodafone/Hoptoad.json?_=1631335739843')
    const { data: { posts: existingBlogPosts } } = await axios.get(' https://forecast.predictwind.com/tracking/blog/Hoptoad?_=1631335739842')

    // filter to only new IDs
    const newLocations = existingLocations.filter(({t}) => !locationIds.includes(t))
    const newBlogPosts = existingBlogPosts.filter(({topic_id}) => !blogIds.includes(topic_id))

    // cleanup data before writing to sheet
    const newLocationsConditioned =  newLocations.map(({t,p,bearing,bsp,twa,twd,tws,gust,isSample}) => ({
        time: t,
        latitude: p.lat,
        longitude: p.lon,
        course: bearing,
        bsp,
        twa,
        twd,
        tws,
        gust,
        isSample
    }))

    // add new
    await locationsSheet.addRows(newLocationsConditioned)
    await blogSheet.addRows(newBlogPosts)

    // print success message
    console.log(`Added ${newLocationsConditioned.length} locations and ${newBlogPosts.length} blog posts.`)

}

cron.schedule('*/10 * * * *', main);

