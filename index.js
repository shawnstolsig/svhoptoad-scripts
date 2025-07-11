const { GoogleSpreadsheet } = require("google-spreadsheet");
const {
    google_spreadsheet_id,
    client_email,
    private_key,
    twilioAccountSid,
    twilioAuthToken,
    twilioFromPhone,
    sanityToken
} = require("./config.json");
const spreadsheet = new GoogleSpreadsheet(google_spreadsheet_id);
const axios = require('axios')
const cron = require('node-cron');
const smsClient = require('twilio')(twilioAccountSid, twilioAuthToken);
const sanityClient = require('@sanity/client')

// init sanity
const sanity = sanityClient({
    projectId: "sq8huxry",
    dataset: "production",
    apiVersion: "v2021-11-23",
    token: sanityToken,
    useCdn: false
})

/**
 * finds a gps fix that's close enough to the blog post, returns this location for storage with the post and photos
 * @param timestamp
 * @param allLocations
 * @returns {{lng, lat, timestamp}}
 */
function findClosestLocation(timestamp, allLocations) {
    const epoch = timestamp.getTime() / 1000
    const flattenedLocations = allLocations.flat(Infinity);
    for (let i = 1; i < flattenedLocations.length; i++) {
        if (flattenedLocations[i].t >= epoch) {
            const {
                t,
                p: {
                    lat,
                    lon
                }
            } = flattenedLocations[i - 1]
            return {
                timestamp: t,
                lat,
                lng: lon,
            }
        }
    }
}

/**
 * takes the 'raw' property from predict wind and breaks it down into text and photos array
 * @param raw
 * @returns {{text: string, photos: *[]}}
 */
function parseRawMessage(raw) {
    // cleanup message, pull out any photos into array
    const photoRegex = /!\[Photo\|\d+x\d+]\((.+)\)/g;
    const photoMatches = raw.match(photoRegex)
    const strippedMsg = raw.replaceAll(photoRegex, '').trim()
    let photos = []

    // if message contains photos
    if (photoMatches) {

        // parse out photo urls from photo string
        photos = photoMatches.map(photo => {

            // regex's used to parse out photo info
            const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
            const filenameRegex = /[^/]*(jpeg|jpg|png)/g
            const dimensionsRegex = /!\[Photo\|\d+x\d+]/g
            const dimensionRegex = /\d+/g

            // find the height and width
            const dimensions = photo.match(dimensionsRegex)
            if (!dimensions) return null
            const heightAndWidth = dimensions[0].match(dimensionRegex)
            if (!heightAndWidth) return null
            const width = Number(heightAndWidth[0])
            const height = Number(heightAndWidth[1])

            // find the url
            const urls = photo.match(urlRegex)
            if (!urls) return null
            const url = urls[0].substring(0, urls[0].length - 1)    // chop off trailing ')'

            // find the filename
            const filenames = url.match(filenameRegex)
            if (!filenames) return null
            return {
                id: filenames[0].replace('.jpeg', '').replace('.jpg', '').replace('.png', ''),
                src: url,
                height,
                width,
                alt: 'Blog Post Photo'
            }
        })
    }

    return {
        text: strippedMsg,
        photos
    }
}

/**
 * stores new blog posts and photos to sanity
 * @param allBlogPosts
 * @param allLocations
 * @returns {Promise<unknown>}
 */
async function storeBlogPosts(allBlogPosts, allLocations) {
    return new Promise(async (resolve, reject) => {

        // diff posts in sanity vs posts in predict wind, filter down to just new posts (minimizes sanity API calls)
        const fetchedBlogPosts = await sanity.fetch(`
        *[_type == 'post']{_id}
        `)
        const storedBlogPostIds = fetchedBlogPosts.map(({ _id }) => _id)
        const newBlogPosts = allBlogPosts.filter(({ topic_id }) => !storedBlogPostIds.includes(topic_id.toString()))

        // iterate through blog posts, create new blog posts if they don't exist
        const promises = newBlogPosts.map(async ({ topic_id, raw, title, created_at, cooked }) => {

            // add 100 ms delay to prevent overloading Sanity api
            await new Promise(res => setTimeout(res, 100));

            const { text, photos } = parseRawMessage(raw)
            const id = topic_id.toString()

            const location = findClosestLocation(new Date(created_at), allLocations)

            const doc = {
                _type: 'post',
                _id: id,
                id,
                title,
                date: created_at,
                type: 'Satellite Update',
                content: text,
                htmlContent: cooked,
                location: location ? location : null,
            }

            return sanity.createIfNotExists(doc).then(async postRes => {
                console.log(`Post ${postRes._id} was created (or was already present).`)

                for (const photo of photos) {
                    const doc = {
                        _type: 'photo',
                        _id: photo.id,
                        post: {
                            _type: 'reference',
                            _ref: id
                        },
                        location: location ? location : null,
                        ...photo
                    }
                    const photoRes = await sanity.createIfNotExists(doc)
                    console.log(`Photo ${photoRes._id} was created (or was already present).`)
                }
            })
        })

        await Promise.all(promises)
        resolve(`Completed storing ${allBlogPosts.length} blog posts.`)
    })
}

/**
 * breaks down blog post into content suitable for texting via Twilio
 * @param toNumber
 * @param message
 * @param title
 * @param timestamp
 * @returns {Promise<MessageInstance>}
 */
async function sendSms(toNumber, message, title, timestamp) {

    // cleanup message, pull out any photos into array
    const photoRegex = /!\[Photo\|\d+x\d+]\((.+)\)/g;
    const photoMatches = message.match(photoRegex)
    const strippedMsg = message.replace(photoRegex, '').trim()

    // format msg with a title row
    const sentAt = new Date(timestamp)
    const dateOptions = { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short' }
    const firstLine = `${sentAt.toLocaleString('en-US', dateOptions)}`
    let formattedMsg = `${firstLine} PST: ${title}\n\n${strippedMsg}`

    // handle messages longer than Twilio's 1600 character limit
    if (formattedMsg.length > 1600) {
        formattedMsg = `${firstLine} PST: ${title}\n\nRead it here: www.svhoptoad.com/blog`
    }

    // if message contains photos
    if (photoMatches) {

        // parse out photo urls from photo string
        const photoUrls = photoMatches.map(photo => {
            const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
            const url = photo.match(urlRegex)
            if (!url) return null                           // return empty element if no url found
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

/**
 * Fetches locations and blog posts from PredictWind
 */
function fetchPredictWindData() {
    return Promise.all([
        axios.get('https://forecast.predictwind.com/tracking/data/Hoptoad.json'),
        axios.get('https://forecast.predictwind.com/tracking/blog/Hoptoad?_=1752196312765')
    ])
}

/**
 * A sepearate cron that will check to see if posts were updated, and then update Sanity accordingly
 **/
async function updateSanityPosts() {

    // diff posts in sanity vs posts in predict wind
    const storedPosts = await sanity.fetch(`
            *[_type == 'post']
        `)

    // get info from Predict Wind
    const [
        { data: { route: pwLocations } },
        { data: { posts: pwBlogPosts } }
    ] = await fetchPredictWindData()

    // find posts to update by comparing: PW.title + SAN.title and PW.cooked + SAN.htmlContent
    const updates = pwBlogPosts.filter(({ topic_id, title, cooked }) => {

        // find stored version from Sanity
        const stored = storedPosts.find(({ _id }) => _id === topic_id.toString())

        // if post isn't stored, omit from updates
        if (!stored) {
            console.log(`couldn't find ${title}, omitting`)
            return false;
        }

        // if title and html content are the same, omit from updates
        if (cooked === stored.htmlContent && title === stored.title) {
            console.log(`post ${title} has title match and content match, omitting`)
            return false;
        }

        // if passed the first two tests, then this is a post to update
        console.log(`----> post ${title} has been previously stored and has been updated, go time!`)
        return true

    })

    // delete existing photos
    await Promise.all(
        updates.map(({ topic_id }) => sanity.delete({ query: `*[_type == 'photo' && post._ref == "${topic_id}"]` }))
    )

    // delete existing versions
    const updateIds = updates.map(({ topic_id }) => topic_id.toString())
    await sanity.delete({ query: `*[_type == 'post' && _id in ${JSON.stringify(updateIds)}]` })

    // recreate blog posts
    await Promise.all(
        updates.map(async ({ topic_id, raw, title, created_at, cooked }) => {

            // add 100 ms delay to prevent overloading Sanity api
            await new Promise(res => setTimeout(res, 100));

            const { text, photos } = parseRawMessage(raw)
            const id = topic_id.toString()

            const location = findClosestLocation(new Date(created_at), pwLocations)

            const doc = {
                _type: 'post',
                _id: id,
                id,
                title,
                date: created_at,
                type: 'Satellite Update',
                content: text,
                htmlContent: cooked,
                location: location ? location : null,
                updatedAt: new Date()
            }

            return sanity.createIfNotExists(doc).then(async postRes => {
                console.log(`Post ${postRes._id} was updated.`)

                for (const photo of photos) {
                    const doc = {
                        _type: 'photo',
                        _id: photo.id,
                        post: {
                            _type: 'reference',
                            _ref: id
                        },
                        location: location ? location : null,
                        ...photo
                    }
                    const photoRes = await sanity.createIfNotExists(doc)
                    console.log(`Photo ${photoRes._id} was created (or was already present).`)
                }
            })
        })
    )

    console.log(`Blog posts updated: ${updates.map(el => el.topic_id)}`)
}

/**
 * uses Predict Wind API to pull blog posts and photos, storing them to Sanity and Google Sheets,
 * and texting out new blog posts via Twilio
 **/
async function main() {

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
    for (let i = 0; i < locationsSheet.rowCount; i++) {
        locationIds.push(locationsSheet.getCell(i, 0).value)
    }
    locationIds = [...new Set(locationIds)].filter(cell => cell)

    // get all blog ids
    const blogSheet = await spreadsheet.sheetsByTitle['Blog Posts']
    await blogSheet.loadCells('A:A')
    let blogIds = []
    for (let i = 0; i < blogSheet.rowCount; i++) {
        blogIds.push(blogSheet.getCell(i, 0).value)
    }
    blogIds = [...new Set(blogIds)].filter(cell => cell)

    // get info from Predict Wind
    const [
        { data: { route: existingLocations } },
        { data: { posts: existingBlogPosts } }
    ] = await fetchPredictWindData()

    // stores new blog posts and photos to sanity
    await storeBlogPosts(existingBlogPosts, existingLocations)

    // filter to only new IDs
    const newLocations = existingLocations.filter(({ t }) => !locationIds.includes(t))
    const newBlogPosts = existingBlogPosts.filter(({ topic_id }) => !blogIds.includes(topic_id))

    // cleanup data before writing to sheet
    const newLocationsConditioned = newLocations.map(({ t, p, bearing, bsp, twa, twd, tws, gust, isSample }) => ({
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

    // add new locations to spreadsheet, if there are any
    if (newLocationsConditioned.length) {
        await locationsSheet.addRows(newLocationsConditioned)
    }

    // get all phone numbers
    // const phoneSheet = await spreadsheet.sheetsByTitle['SMS Subscribers']
    // await phoneSheet.loadCells('A:A')
    // let phoneNumbers = []
    // for(let i = 0; i < phoneSheet.rowCount; i++){
    //     phoneNumbers.push(phoneSheet.getCell(i,0).value)
    // }
    // phoneNumbers = [...new Set(phoneNumbers)].filter(cell => cell).map(num => num.toString())

    // add new blog posts to spreadsheet, if there are any
    // let smsToSend = []
    if (newBlogPosts.length) {
        await blogSheet.addRows(newBlogPosts)

        // send blog posts over sms
        // phoneNumbers.forEach(number => {
        //     newBlogPosts.forEach(({raw, title, created_at: timestamp}) => smsToSend.push(sendSms(number, raw, title, timestamp)))
        // })
        // await Promise.all(smsToSend)
    }

    // print success message
    console.log(`Added ${newLocationsConditioned.length} locations and ${newBlogPosts.length} blog posts.  SMS disabled.`)
}

cron.schedule('*/10 * * * *', main);
cron.schedule('*/60 * * * *', updateSanityPosts);

// updateSanityPosts();
// main()
