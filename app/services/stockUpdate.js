/**
 * Copyright 2018 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License'); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

const config = require('../../config');
const utils  = require('../util/utils');

const stock_db  = config.configured && require('../util/cloudantDb');
const discovery = config.configured && require('./discovery');
const alphaV = config.configured && require('./alphaVantage');
const request = require('request');
const cheerio = require('cheerio');

/**
 * Sorts and returns the articles from most to least recent by date
 * @param {article[]} articles
 * @returns {article[]} - the sorted articles
 */
function sortArticles(articles) {
  
  articles.sort(function(a, b) {
    return new Date(b.date) - new Date(a.date);
  });
  
  return articles;
}

/**
 * Searches for the given article in the list of articles
 * @param {article} article
 * @param {article[]} articles
 * @returns {boolean} - True if the article is found, false otherwise
 */
function articleContains(article, articles) {
  for (var x=0; x<articles.length; x++) {
    if (article.url === articles[x].url) {
      return true;
    }
  }
  return false;
}

/**
 * Finds the image for the given article
 * @param {article} article
 * @returns {promise} - The result will be of the form {url: url, imageURL: imageURL},
 * or undefined if no image found
 */
function getImageForArticle(article) {
  return new Promise((res, rej) => {
    var url = article.url;
    request(url, function(error, response, html) {

      var fail = function() {
        console.log('no image url found for article with url: (' + url + ')');
        res();
      };

      if (!error){
        var $ = cheerio.load(html);
        var imgSrc = $.root().find('img').attr('src');
        if (!imgSrc) {
          imgSrc = $('body').find('img').attr('src');
        }
        if (imgSrc) {
          var imageURL;
          var httpURL = utils.extractHTTPURL(imgSrc);
          if (httpURL) {
            imageURL = httpURL;
          } else {
            //in this case, imgSrc *should* be a relative path
            var domain = utils.extractDomain(url);
            imageURL = domain + '/' + (imgSrc.startsWith('/') ? imgSrc.slice(1) : imgSrc);
          }
          console.log('image url (' + imageURL + ') found for article with url: (' + url + ')');
          res({url: url, imageURL: imageURL});
        } else {
          fail();
        }
      } else {
        rej();
      }
    });
  });
}

/**
 * Try to find and add image urls to each article
 * @param {article[]} articles
 */
function getImages(articles) {

  return new Promise((resolve, reject) => {
    var catches = [];

    for (var i=0; i<articles.length; i++) {
      var article = articles[i];
      var promise = getImageForArticle(article);
      catches.push(promise.catch(e => {
        console.log('Error finding img url for ');
        return e;
      }));
    }

    //we wait here until all attempts are finished.
    //we may not be able to retrieve image urls for all articles...
    //and that's ok. since we are Promise.all-ing caught promises,
    //we allow any outstanding promises to continue even if one of them fails.
    //the catch block here should never fire, but we place it for good measure
    Promise.all(catches).then((tempResults) => {
      var results = [];
      for (var x=0; x<tempResults.length; x++) {
        var tempRes = tempResults[x];
        if (tempRes && tempRes.url) {
          results.push(tempRes);
        }
      }
      resolve(results);
    }).catch((error) => {
      resolve(results);
    });
  });
}

/**
 * Inserts the new articles for the given stockDatum
 * @param {stock} stockDatum - The existing stock datum
 * @param {articles[]} newArticles - The article to be added
 * @param {function} callback - the function to call on completion
 */
function insertNewArticles(stockDatum, newArticles, callback) {
  getImages(newArticles).then((imgResults) => {
    for (var x=0; x<imgResults.length; x++) {
      var imgResult = imgResults[x];
      for (var y=0; y<newArticles.length; y++) {
        var newArtic = newArticles[y];
        if (newArtic.url === imgResult.url) {
          newArtic.imageURL = imgResult.imageURL;
          break;
        }
      }
    }
    var existingArticles = stockDatum.history || [];
    var updatedArticles = sortArticles(existingArticles.concat(newArticles));
    var company = stockDatum.company;
    if (updatedArticles.length > config.MAX_ARTICLES_PER_COMPANY) {
      console.log('"' + company + '" has exceeded article max of ' + config.MAX_ARTICLES_PER_COMPANY + '...');
      console.log('Removing ' + (updatedArticles.length - config.MAX_ARTICLES_PER_COMPANY) + ' oldest article(s) from "' + company + '" history...');
      updatedArticles = updatedArticles.slice(0, config.MAX_ARTICLES_PER_COMPANY);
    }
    stockDatum.history = updatedArticles;
    console.log('Inserting into company "' + company + '" articles: ' );
    console.log(newArticles);
    //TODO batch insert?
    stock_db.insertOrUpdate(stockDatum).catch((error) => {
      console.log(error);
    });
    callback();
  }).catch(() => {
    callback();
  });
}

/**
 * Retrieves the latest price history for the stock and
 * combines it with the existing history
 * @param {stock} stockDatum
 * @returns promise - The result is the updated stock, if successful
 */
function getLatestStockPrices(stockDatum) {

  return new Promise((resolve, reject) => {
    if (!stockDatum || !stockDatum.ticker) {
      reject();
      return;
    }

    var ticker = stockDatum.ticker;
    console.log('Beginning stock price update for ' + ticker);

    alphaV.getPriceHistoryForTicker(ticker).then((updatedHistory) => {
      
      //combine the existing price history with the newly retrieved history
      var newHistory = stockDatum.price_history || {};
      for (var date in updatedHistory) {
        if (updatedHistory.hasOwnProperty(date)) {
          newHistory[date] = updatedHistory[date];
        }
      }
      stockDatum.price_history = newHistory;
      resolve(stockDatum);
    }).catch((error) => {
      reject(error);
    });
  });
}

/**
 * Finds the stock price for the given date, or the latest prior to that date, if available
 * @param {string} date
 * @param {[]} priceList - sorted price list e.g. [{date:'2018-01-25', price: 35.9}, {date:'2018-01-27', price: 36.21}]
 * @returns pricepair - e.g. {date:'2018-01-25', price: 35.9}
 */
function getPairForDate(date, priceList) {

  if (!date || !priceList) {
    return undefined;
  }

  var pair = undefined;
  var realDate = utils.avDateStringToDate(date);
  var numPairs = priceList.length;
  for (var i=0; i<numPairs; i++) {
    var thisPair = priceList[i];
    if (thisPair.date == date) {
      return thisPair;
    }
    var thisDate = utils.avDateStringToDate(thisPair.date);
    if (thisDate > realDate) {
      var price = thisPair.price;
      var previousInd = i - 1;
      if (previousInd >= 0) {
        var previous = priceList[previousInd];
        console.log('No price exists for ' + date + ' , using previous of ' + previous.date);
        price = previous.price;
      }
      return {date: date, price: price};
    }
  }

  //default to the most recent date if none available and
  //it is earlier than this date
  if (numPairs > 0 && realDate > utils.avDateStringToDate(priceList[numPairs - 1].date)) {
    return thisPair;
  }

  return undefined;
}

/**
 * Updates the database with the article data. New (unique) articles
 * are inserted into the database. Duplicates are removed. The articles
 * are sorted from most to least recent for each before updating DB.
 * @param {article[]} articleData
 * @param {stocks[]} stockData
 * @returns {stocks[]} - the updated results
 */
function updateStocksData(articleData, stockData) {
  
  var results = stockData;
  var catches = [];

  for (var i=0; i<articleData.length; i++) {
    
    var promise = new Promise((res, rej) => {
      var articleDatum = articleData[i];
      var company = articleDatum.company;
      console.log('Beginning article insertion for "' + company + '"');
      var stockDatum = utils.findStockDatum(stockData, company);
      if (!stockDatum) {
        stockDatum = {
          company : company,
          ticker  : findTickerForCompanyWithName(company) || 'No Ticker Found',
          history : []
        };
        results.push(stockDatum);
      }
      var existingArticles = stockDatum.history || [];
      
      //filter existing articles
      var newArticles = articleDatum.articles.filter(function(article) {
        var articleExists = articleContains(article, existingArticles);
        if (articleExists) {
          console.log('Not adding duplicate article: ' + article.url);
        }
        return !articleExists;
      });

      if (newArticles.length > 0) {
        getLatestStockPrices(stockDatum).then((updatedStock) => {
          console.log('stock price retrieval successful for ' + stockDatum.ticker);

          //filter for stock prices on dates for which we have articles
          //and generate, if possible, missing prices
          var neededDates = existingArticles.concat(newArticles).filter(function(art) {
            return art && typeof art.date != 'undefined';
          }).map(function(artic) {
            return utils.convertArticleDateToAVDate(artic.date);
          });
          //filter duplicates
          neededDates = Array.from(new Set(neededDates));
          var filteredPriceHistory = {};
          var priceMap = stockDatum.price_history;
          var sortedPrices = utils.convertPriceMapToList(priceMap);
          for (var q=0; q<neededDates.length; q++) {
            var date = neededDates[q];
            var pair = getPairForDate(date, sortedPrices);
            if (pair) {
              filteredPriceHistory[pair.date] = pair.price;
            }
          }

          stockDatum.price_history = filteredPriceHistory;
          insertNewArticles(updatedStock, newArticles, function() {
            res();
          });
        }).catch((error) => {
          console.log('stock price retrieval failed:');
          console.log(error);
          insertNewArticles(stockDatum, newArticles, function() {
            res();
          });
        });
      } else {
        console.log('No new articles to insert into "' + company + '"');
        res();
      }
    });

    catches.push(promise.catch(e => {
      console.log('Error inserting stock data for ' + company);
      return e;
    }));
  }

  return new Promise((resolve, reject) => {
    Promise.all(catches).then(() => {
      resolve(results);
    }).catch((error) => {
      console.log(error);
      resolve(results);
    });
  });
}

/**
 * Parses a single discovery result for the relevant data
 * @param {discoveryResult} result
 * @returns {object} - a simplified JSON object with relevant data
 */
function parseArticle(result) {
  return {
    url: result.url,
    sentiment: result.enriched_text.sentiment.document.label,
    date: result.crawl_date,
    title: result.title,
    source: result.forum_title
  };
}

/**
 * Parses raw Watson Discovery Results for articles
 * @param {result[]} results
 * @returns {article[]} - The parsed articles
 */
function parseResults(results) {
  var articles = [];
  for (var i=0; i<results.length; i++) {
    articles.push(parseArticle(results[i]));
  }
  return articles;
}

/**
 * Retrieves article data for the given company
 * @param {string} company
 * @param {function} callback - Called after retrieval and parsing complete
 * @returns {promise} - The promise for the request to Watson Discovery
 */
function getArticleDataForCompany(company, callback) {
  
  var filterDuplicates = function(articles) {
    var seen = {};
    return articles.filter(function(article) {
      var wasSeen = seen.hasOwnProperty(article.url);
      if (!wasSeen) {
        seen[article.url] = true;
      } else {
        console.log('Received duplicate article ' + article.url + ' from Discovery');
      }
      return !wasSeen;
    });
  };

  var promise = discovery.query(company);
    
  promise.then(function (data) {
    var results = data.results;
    var articles = filterDuplicates(parseResults(results));
    console.log('Received ' + articles.length + ' unique articles for "' + company + '" from Discovery');
    var data = {
      company : company,
      articles : articles
    };
    callback(data);
  }).catch(function (error) {
    callback([], error);
  });
  
  return promise;
}

/**
 * Retrieves article data for the given company
 * @param {string[]} companies - The list of companies to retrieve articles for
 * @param {function} callback - Called after retrieval and parsing complete
 */
function getArticleDataForCompanies(companies, callback) {
  
  var promises = [];
  var articleData = [];
  var errors = [];
  
  for (var i=0; i<companies.length; i++) {
    var company = companies[i];
    console.log('Starting discovery for "' + company + '"');
    var promise = getArticleDataForCompany(company, function(articleDataForCompany, error) {
      if (error) {
        errors = errors.concat(error);
      } else {
        articleData = articleData.concat(articleDataForCompany);
      }
    });
    promises.push(promise);
  }
  
  Promise.all(promises).then(function() {
    if (utils.isFunc(callback)) {
      callback(articleData);
    }
  }).catch(function(error) {
    if (utils.isFunc(callback)) {
      callback(articleData, errors.join());
    }
  });
}

/**
 * Finds the corresponding ticker for a company with the given name.
 * @param {name} name
 * @returns {string} - the ticker, or undefined if no such company exists
 */
function findTickerForCompanyWithName(name) {

  for (var i=0; i<config.companies.length; i++) {
    var company = config.companies[i];
    if (name === company.name) {
      return company.ticker;
    }
  }
  return undefined;
}

class StockUpdate {
  
  /**
   * Retrieve new data for the given companies
   * @param {string[]} companies
   * @returns {promise}
   */
  run(companies) {

    return new Promise((resolve, reject) => {
      if (!config.configured) {
        console.log('Project is not configured correctly...terminating');
        reject();
      }

      stock_db.search().then((rows)  => {
        var docs = rows.map(function(row) {
          return row.doc;
        });

        //if no companies provided, update all in DB
        if (!companies) {
          companies = docs.map(function(doc) {
            return doc.company;
          });
        }
        if (companies && companies.length > 0) {
          getArticleDataForCompanies(companies, function(articleData, articlesErr) {
            if (!articlesErr) {
              updateStocksData(articleData, docs).then((results) => {
                resolve(results);
              }).catch((results) => {
                //updateStocksData never rejects, so resolving here is a failsafe
                resolve(results);
              });
            } else {
              console.log(articlesErr);
              reject();
            }
          });
        } else {
          console.log('No companies to update');
          reject();
        }
      }).catch((docsErr) => {
        console.log(docsErr);
        reject();
      });
    });
  }
}

module.exports = StockUpdate;
