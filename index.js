const {GoogleSpreadsheet} = require("google-spreadsheet");
const {google_spreadsheet_id, client_email, private_key} = require("./config.json");
const doc = new GoogleSpreadsheet(google_spreadsheet_id);

async function main(){
    await doc.useServiceAccountAuth({
        client_email,
        private_key
    });

    await doc.loadInfo();

    console.log(doc.title)
}
main()