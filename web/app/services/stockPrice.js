
//---CONFIGURE AUTHENTICATION HERE--------------------
var API_KEY = 'demo';
//----------------------------------------------------

var AlphaVantageAPI = require('alpha-vantage-cli').AlphaVantageAPI;
var alphaVantageAPI = new AlphaVantageAPI(API_KEY, 'compact', true);
var companyTicker = 'MSFT';

alphaVantageAPI.getDailyData(companyTicker)
    .then(dailyData => {
        // console.log("Daily data:");
        // console.log(typeof dailyData);
        stockPriceMap = parsedailyData(dailyData);
        for (date in stockPriceMap){
        	console.log(date + ": " + stockPriceMap[date]);
        }
    })
    .catch(err => {
        console.error(err);
    });

function parsedailyData(dailyData) {
	var stockPriceMap = {};

	for (var id in dailyData){
		var date = dailyData[id]["Timestamp"];
		var dateString = JSON.stringify(date);
		dateString = dateString.slice(1,11);
		var price = dailyData[id]["Close"];
		stockPriceMap[dateString] = [];
		stockPriceMap[dateString].push(price); // date:price
	}
	return stockPriceMap;
 }
}

