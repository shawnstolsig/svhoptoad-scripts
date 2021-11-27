const {
    sanityToken
} = require("./config.json");
const sanityClient = require('@sanity/client')

// init sanity
const sanity = sanityClient({
    projectId: "sq8huxry",
    dataset: "production",
    apiVersion: "v2021-11-23",
    token: sanityToken,
    useCdn: false
})

async function main(){
    await sanity
        .delete({query: '*[_type == "photo"]'})
        .then(console.log)
        .catch(console.error)
    await sanity
        .delete({query: '*[_type == "post"]'})
        .then(console.log)
        .catch(console.error)
}
main()
