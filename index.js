const { GoogleSpreadsheet } = require("google-spreadsheet");
const {
    google_spreadsheet_id,
    client_email,
    private_key,
    twilioAccountSid,
    twilioAuthToken,
    twilioFromPhone
} = require("./config.json");
const spreadsheet = new GoogleSpreadsheet(google_spreadsheet_id);
const axios = require('axios')
const cron = require('node-cron');
const smsClient = require('twilio')(twilioAccountSid, twilioAuthToken);

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
    phoneNumbers = [...new Set(phoneNumbers)].filter(cell => cell).map(num => num.toString())

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

    // add new rows to spreadsheet
    await locationsSheet.addRows(newLocationsConditioned)
    await blogSheet.addRows(newBlogPosts)

    // send blog posts over sms
    let smsToSend = []
    phoneNumbers.forEach(number => {
        newBlogPosts.forEach(({raw, title, created_at: timestamp}) => smsToSend.push(sendSms(number, raw, title, timestamp)))
    })
    await Promise.all(smsToSend)

    // print success message
    console.log(`Added ${newLocationsConditioned.length} locations and ${newBlogPosts.length} blog posts.  ${smsToSend.length} texts sent.`)

}

async function sendSms(toNumber, message, title, timestamp){

    // cleanup message, pull out any photos into array
    const photoRegex = /!\[Photo\|\d+x\d+]\((.+)\)/g;
    const photoMatches = message.match(photoRegex)
    const strippedMsg = message.replace(photoRegex, '').trim()

    // format msg with a title row
    const sentAt = new Date(timestamp)
    const dateOptions = { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short' }
    const firstLine = `${sentAt.toLocaleString('en-US', dateOptions)}`
    const formattedMsg = `${firstLine} PST: ${title}\n\n${strippedMsg}`

    // if message contains photos
    if(photoMatches){

        // parse out photo urls from photo string
        const photoUrls = photoMatches.map(photo => {
            const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
            const url = photo.match(urlRegex)
            if(!url) return null                           // return empty element if no url found
            return url[0].substring(0, url[0].length - 1)  // chop off trailing ')'
        })

        // send sms with media
        return smsClient.messages.create({
            body: formattedMsg,
            from: twilioFromPhone,
            to: `+1${toNumber}`,
            mediaUrl: photoUrls
        })
    }

    // if no media, send regular sms
    return smsClient.messages.create({
            body: formattedMsg,
            from: twilioFromPhone,
            to: `+1${toNumber}`
        })

}

cron.schedule('*/10 * * * *', main);
