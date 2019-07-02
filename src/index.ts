import TelegramBot = require('node-telegram-bot-api');
import uuid = require('uuid/v4');
import downloadUtils = require('./download_tools/utils');
import ariaTools = require('./download_tools/aria-tools.js');
import constants = require('./.constants.js');
import msgTools = require('./msg-tools.js');
import dlm = require('./dl_model/dl-manager');
import driveList = require('./drive/drive-list.js');
import driveUtils = require('./drive/drive-utils.js');
import details = require('./dl_model/detail');
import filenameUtils = require('./download_tools/filename-utils');
const bot = new TelegramBot(constants.TOKEN, { polling: true });
var websocketOpened = false;
var statusInterval: NodeJS.Timeout;
var dlManager = dlm.DlManager.getInstance();

initAria2();

bot.on("polling_error", msg => console.log(msg.message));

bot.onText(/^\/start/, (msg) => {
  if (msgTools.isAuthorized(msg) < 0) {
    sendUnauthorizedMessage(msg);
  } else {
    sendMessage(msg, 'You should know the commands already. Happy mirroring.');
  }
});

bot.onText(/^\/mirrortar (.+)/i, (msg, match) => {
  if (msgTools.isAuthorized(msg) < 0) {
    sendUnauthorizedMessage(msg);
  } else {
    mirror(msg, match, true);
  }
});

bot.onText(/^\/mirror (.+)/i, (msg, match) => {
  if (msgTools.isAuthorized(msg) < 0) {
    sendUnauthorizedMessage(msg);
  } else {
    mirror(msg, match);
  }
});

/**
 * Start a new download operation. Make sure that this is triggered by an
 * authorized user, because this function itself does not check for that.
 * @param {Object} msg The Message that triggered the download
 * @param {Array} match Message matches
 * @param {boolean} isTar Decides if this download should be archived before upload
 */
function mirror(msg: TelegramBot.Message, match: RegExpExecArray, isTar?: boolean) {
  if (websocketOpened) {
    if (downloadUtils.isDownloadAllowed(match[1])) {
      prepDownload(msg, match[1], isTar);
    } else {
      sendMessage(msg, `Download failed. Blacklisted URL.`);
    }
  } else {
    sendMessage(msg, `Websocket isn't open. Can't download`);
  }
}

bot.onText(/^\/mirrorStatus/i, (msg) => {
  if (msgTools.isAuthorized(msg) < 0) {
    sendUnauthorizedMessage(msg);
  } else {
    sendStatusMessage(msg);
  }
});

function getSingleStatus(dlDetails: details.DlVars, msg?: TelegramBot.Message): Promise<string> {
  return new Promise((resolve, reject) => {
    var authorizedCode;
    if (msg) {
      authorizedCode = msgTools.isAuthorized(msg);
    } else {
      authorizedCode = 1;
    }

    if (authorizedCode > -1) {
      ariaTools.getStatus(dlDetails.gid, (err, message, filename) => {
        if (err) {
          reject(`Error: ${dlDetails.gid} - ${err}`);
        } else {
          if (dlDetails.isUploading) {
            resolve(`<i>${filename}</i> - Uploading`);
          } else {
            handleDisallowedFilename(dlDetails, filename);
            resolve(message);
          }
        }
      });
    } else {
      reject(`You aren't authorized to use this bot here.`);
    }
  });
}

bot.onText(/^\/list (.+)/i, (msg, match) => {
  if (msgTools.isAuthorized(msg) < 0) {
    sendUnauthorizedMessage(msg);
  } else {
    driveList.listFiles(match[1], (err, res) => {
      if (err) {
        sendMessage(msg, 'Failed to fetch the list of files');
      } else {
        sendMessage(msg, res, 60000);
      }
    });
  }
});


bot.onText(/^\/cancelMirror/i, (msg) => {
  var authorizedCode = msgTools.isAuthorized(msg);
  if (msg.reply_to_message) {
    var dlDetails = dlManager.getDownloadByMsgId(msg.reply_to_message);
    if (dlDetails) {
      if (authorizedCode > -1 && authorizedCode < 3) {
        cancelMirror(dlDetails, msg);
      } else if (authorizedCode === 3) {
        msgTools.isAdmin(bot, msg, (e, res) => {
          if (res) {
            cancelMirror(dlDetails, msg);
          } else {
            sendMessage(msg, 'You do not have permission to do that.');
          }
        });
      } else {
        sendMessage(msg, 'You cannot use this bot here.');
      }
    } else {
      sendMessage(msg, `Reply to the command message, or the bot's download confirmation message` +
        ` for the download that you want to cancel. Also make sure that the download even active.`);
    }
  } else {
    sendMessage(msg, `Reply to the command message, or the bot's download confirmation message` +
      ` for the download that you want to cancel.`);
  }
});

function cancelMirror(dlDetails: details.DlVars, cancelMsg?: TelegramBot.Message) {
  if (dlDetails.isUploading) {
    if (cancelMsg) {
      sendMessage(cancelMsg, 'Upload in progress. Cannot cancel.');
    }
  } else {
    ariaTools.stopDownload(dlDetails.gid, () => {
      // Not sending a message here, because a cancel will fire
      // the onDownloadStop notification, which will notify the
      // person who started the download

      if (cancelMsg && dlDetails.tgChatId !== cancelMsg.chat.id) {
        // Notify if this is not the chat the download started in
        sendMessage(cancelMsg, 'The download was canceled.');
      }
      if (!dlDetails.isDownloading) {
        // onDownloadStopped does not fire for downloads that haven't started yet
        // So calling this here
        ariaOnDownloadStop(dlDetails.gid, 1);
      }
    });
  }
}

/**
 * Cancels the download if its filename contains a string from
 * constants.ARIA_FILTERED_FILENAMES. Call this on every status message update,
 * because the file name might not become visible for the first few status
 * updates, for example, in case of BitTorrents.
 *
 * @param {String} filename The name of the downloaded file/top level directory
 * @returns {boolean} False if file name is disallowed, true otherwise,
 *                    or if undetermined
 */
function handleDisallowedFilename(dlDetails: details.DlVars, filename: string): boolean {
  if (dlDetails) {
    if (dlDetails.isDownloadAllowed === 0) return false;
    if (dlDetails.isDownloadAllowed === 1) return true;
    if (!filename) return true;

    var isAllowed = filenameUtils.isFilenameAllowed(filename);
    if (isAllowed === 0) {
      dlDetails.isDownloadAllowed = 0;
      if (dlDetails.isDownloading && !dlDetails.isUploading) {
        cancelMirror(dlDetails);
      }
      return false;
    } else if (isAllowed === 1) {
      dlDetails.isDownloadAllowed = 1;
    }
  }
  return true;
}

function prepDownload(msg: TelegramBot.Message, match: string, isTar: boolean) {
  sendMessage(msg, 'Preparing', -1, statusMessage => {
    var dlDir = uuid();
    ariaTools.addUri(match, dlDir, (err, gid) => {
      dlManager.addDownload(gid, dlDir, msg, statusMessage, isTar);
      if (err) {
        var message = `Failed to start the download. ${err.message}`;
        console.error(message);
        cleanupDownload(gid, message);
      } else {
        console.log(`download:${match} gid:${gid}`);
      }
    });
  });

}

function sendMessage(msg: TelegramBot.Message, text: string, delay?: number,
  callback?: (res: TelegramBot.Message) => void, quickDeleteOriginal?: boolean) {
  if (!delay) delay = 5000;
  bot.sendMessage(msg.chat.id, text, {
    reply_to_message_id: msg.message_id,
    parse_mode: 'HTML'
  })
    .then((res) => {
      if (callback) callback(res);
      if (delay > -1) {
        msgTools.deleteMsg(bot, res, delay);
        if (quickDeleteOriginal) {
          msgTools.deleteMsg(bot, msg);
        } else {
          msgTools.deleteMsg(bot, msg, delay);
        }
      }
    })
    .catch((ignored) => { });
}

function sendUnauthorizedMessage(msg: TelegramBot.Message) {
  sendMessage(msg, `You aren't authorized to use this bot here.`);
}

function sendMessageReplyOriginal(dlDetails: details.DlVars, message: string): Promise<TelegramBot.Message> {
  return bot.sendMessage(dlDetails.tgChatId, message, {
    reply_to_message_id: dlDetails.tgMessageId,
    parse_mode: 'HTML'
  })
}

/**
 * Get a single status message for all active and queued downloads.
 */
function getStatusMessage(callback: (err: string, message: string) => void) {
  var singleStatusArr: Promise<string>[] = [];

  dlManager.forEachDownload(dlDetails => {
    singleStatusArr.push(getSingleStatus(dlDetails));
  });

  Promise.all(singleStatusArr)
    .then(statusArr => {
      if (statusArr && statusArr.length > 0) {
        callback(null, statusArr.reduce((prev, curr, i) => {
          return i > 0 ? `${prev}\n\n${curr}` : `${curr}`;
        }));
      } else {
        callback(null, 'No active or queued downloads');
      }
    })
    .catch(error => {
      console.log(`getStatusMessage: ${error}`);
      callback(error, null);
    })
}

/**
 * Sends a single status message for all active and queued downloads.
 */
function sendStatusMessage(msg: TelegramBot.Message) {
  var lastStatus = dlManager.getStatus(msg.chat.id);

  if (lastStatus) {
    msgTools.deleteMsg(bot, lastStatus);
    dlManager.deleteStatus(msg.chat.id);
  }

  getStatusMessage((err, messageText) => {
    var finalMessage = err ? err : messageText;
    sendMessage(msg, finalMessage, 60000, message => {
      dlManager.addStatus(message);
    }, true);
  });
}

/**
 * Updates the original status message sent by the bot as a reply to the
 * download command message.
 */
function updateStatusMessage(dlDetails: details.DlVars, text?: string) {
  if (text) {
    editMessage(dlDetails.origStatusMsg, text);
  } else {
    getSingleStatus(dlDetails)
      .then(res => {
        editMessage(dlDetails.origStatusMsg, res);
      })
      .catch(err => {
        console.log(`updateStatusMessage: ${err}`);
        editMessage(dlDetails.origStatusMsg, err);
      })
  }
}

/**
 * Updates all general status messages
 */
function updateAllGeneralStatus() {
  getStatusMessage((err, messageText) => {
    var finalMessage = err ? err : messageText;
    dlManager.forEachStatus(statusMessage => {
      editMessage(statusMessage, finalMessage);
    });
  });
}

/**
 * Updates all general status messages, and all single status messages
 * sent to individual download commands.
 */
function updateAllStatus() {
  var dlCount = 0;
  // TODO: Both updateAllGeneralStatus() and updateStatusMessage() fetch the 
  // status of each individual download. Rewrite to get each status only once.
  updateAllGeneralStatus();
  dlManager.forEachDownload(dlDetails => {
    dlCount++;
    updateStatusMessage(dlDetails);
  });

  if (dlCount === 0) {
    // No more active or queued downloads, let's stop the status refresh timer
    clearInterval(statusInterval);
    statusInterval = null;
  }
}

function editMessage(msg: TelegramBot.Message, text: string) {
  if (msg && msg.chat && msg.chat.id && msg.message_id) {
    bot.editMessageText(text, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: 'HTML'
    })
      .catch(ignored => { });
  }
}

/**
 * Deletes the bot's original response to the download command, if less
 * than 10 messages have been sent to the group the download started in,
 * since the download was started. Deleted messages also count. Message
 * IDs are usually consecutive numbers, though that is not guaranteed by
 * the Telegram API. This function is not important enough for that to matter.
 **/
function deleteOrigReply(dlDetails: details.DlVars, lastStatusMsg: TelegramBot.Message) {
  if (lastStatusMsg.message_id - dlDetails.origStatusMsg.message_id < 10) {
    msgTools.deleteMsg(bot, dlDetails.origStatusMsg, 0);
  }
}

/**
 * After a download is complete (failed or otherwise), call this to clean up.
 * @param gid The gid for the download that just finished
 * @param message The message to send as the Telegram download complete message
 * @param url The public Google Drive URL for the uploaded file
 */
function cleanupDownload(gid: string, message: string, url?: string, dlDetails?: details.DlVars) {
  if (!dlDetails) {
    dlDetails = dlManager.getDownloadByGid(gid);
  }
  if (dlDetails) {
    sendMessageReplyOriginal(dlDetails, message)
      .then(msg => deleteOrigReply(dlDetails, msg))
      .catch();
    updateStatusMessage(dlDetails, message);
    if (url) {
      msgTools.notifyExternal(true, gid, dlDetails.tgChatId, url);
    } else {
      msgTools.notifyExternal(false, gid, dlDetails.tgChatId);
    }
    dlManager.deleteDownload(gid);
    updateAllGeneralStatus();
    downloadUtils.deleteDownloadedFile(dlDetails.downloadDir);
  } else {
    // Why is this message so calm? We should be SCREAMING at this point!
    console.error(`cleanupDownload: Could not get dlDetails for ${gid}`);
  }
}

function ariaOnDownloadStart(gid: string, retry: number) {
  var dlDetails = dlManager.getDownloadByGid(gid);
  if (dlDetails) {
    dlManager.moveDownloadToActive(dlDetails);
    console.log(`Started ${gid}. Dir: ${dlDetails.downloadDir}.`);
    updateStatusMessage(dlDetails, 'Download started.');

    ariaTools.getStatus(gid, (err, message, filename) => {
      if (!err) {
        handleDisallowedFilename(dlDetails, filename);
      }
    });

    if (!statusInterval) {
      statusInterval = setInterval(updateAllStatus, 4000);
    }
  } else if (retry <= 8) {
    // OnDownloadStart probably got called before prepDownload's startDownload callback. Fairly common. Retry.
    console.log(`onDownloadStart: DlDetails empty for ${gid}. ${retry} / 8.`);
    setTimeout(() => ariaOnDownloadStart(gid, retry + 1), 500);
  } else {
    console.error(`onDownloadStart: DlDetails still empty for ${gid}. Giving up.`);
  }
}

function ariaOnDownloadStop(gid: string, retry: number) {
  var dlDetails = dlManager.getDownloadByGid(gid);
  if (dlDetails) {
    console.log('stop', gid);
    var message = 'Download stopped.';
    if (dlDetails.isDownloadAllowed === 0) {
      message += ' Blacklisted file name.';
    }
    cleanupDownload(gid, message);
  } else if (retry <= 8) {
    // OnDownloadStop probably got called before prepDownload's startDownload callback. Unlikely. Retry.
    console.log(`onDownloadStop: DlDetails empty for ${gid}. ${retry} / 8.`);
    setTimeout(() => ariaOnDownloadStop(gid, retry + 1), 500);
  } else {
    console.error(`onDownloadStop: DlDetails still empty for ${gid}. Giving up.`);
  }
}

function ariaOnDownloadComplete(gid: string, retry: number) {
  var dlDetails = dlManager.getDownloadByGid(gid);
  if (dlDetails) {

    ariaTools.getAriaFilePath(gid, (err, file) => {
      if (err) {
        console.error(`onDownloadComplete: Error getting file path for ${gid}. ${err}`);
        var message = 'Upload failed. Could not get downloaded files.';
        cleanupDownload(gid, message);
        return;
      }

      if (file) {
        ariaTools.getFileSize(gid, (err, size) => {
          if (err) {
            console.error(`onDownloadComplete: Error getting file size for ${gid}. ${err}`);
            var message = 'Upload failed. Could not get file size.';
            cleanupDownload(gid, message);
            return;
          }

          var filename = filenameUtils.getFileNameFromPath(file, null);
          dlDetails.isUploading = true;
          if (handleDisallowedFilename(dlDetails, filename)) {
            console.log(`${gid} complete. Filename: ${filename}. Starting upload.`);
            ariaTools.uploadFile(dlDetails, file, size, driveUploadCompleteCallback);
          } else {
            var reason = 'Upload failed. Blacklisted file name.';
            console.log(`${gid} blacklisted. Filename: ${filename}.`);
            cleanupDownload(gid, reason);
          }
        });
      } else {
        ariaTools.isDownloadMetadata(gid, (err, isMetadata, newGid) => {
          if (err) {
            console.error(`onDownloadComplete: Failed to check if ${gid} was a metadata download: ${err}`);
            var message = 'Upload failed. Could not check if the file is metadata.';
            cleanupDownload(gid, message);
          } else if (isMetadata) {
            console.log(`Changing GID from ${gid} to ${newGid}`);
            dlManager.changeDownloadGid(gid, newGid);
          } else {
            console.error('onDownloadComplete: No files - not metadata.');
            var reason = 'Upload failed. Could not get files.';
            cleanupDownload(gid, reason);
          }
        });
      }
    });
  } else if (retry <= 8) {
    // OnDownloadComplete probably got called before prepDownload's startDownload callback. Highly unlikely. Retry.
    console.log(`onDownloadComplete: DlDetails empty for ${gid}. ${retry} / 8.`);
    setTimeout(() => ariaOnDownloadComplete(gid, retry + 1), 500);
  } else {
    console.error(`onDownloadComplete: DlDetails still empty for ${gid}. Giving up.`);
  }
}

function ariaOnDownloadError(gid: string, retry: number) {
  var dlDetails = dlManager.getDownloadByGid(gid);
  if (dlDetails) {
    ariaTools.getError(gid, (err, res) => {
      var message: string;
      if (err) {
        message = 'Failed to download.';
        console.error(`${gid} failed. Failed to get the error message. ${err}`);
      } else {
        message = `Failed to download. ${res}`;
        console.error(`${gid} failed. ${res}`);
      }
      cleanupDownload(gid, message, null, dlDetails);
    });
  } else if (retry <= 8) {
    // OnDownloadError probably got called before prepDownload's startDownload callback,
    // or gid refers to a torrent files download, and onDownloadComplete for the torrent's
    // metadata hasn't been called yet. Fairly likely. Retry.
    console.log(`onDownloadError: DlDetails empty for ${gid}. ${retry} / 8.`);
    setTimeout(() => ariaOnDownloadError(gid, retry + 1), 500);
  } else {
    console.error(`onDownloadError: DlDetails still empty for ${gid}. Giving up.`);
  }
}

function initAria2() {
  ariaTools.openWebsocket((err) => {
    if (err) {
      console.error('A2C: Failed to open websocket. Run aria.sh first. Exiting.');
      process.exit();
    } else {
      websocketOpened = true;
      console.log('A2C: Websocket opened. Bot ready.');
    }
  });

  ariaTools.setOnDownloadStart(ariaOnDownloadStart);
  ariaTools.setOnDownloadStop(ariaOnDownloadStop);
  ariaTools.setOnDownloadComplete(ariaOnDownloadComplete);
  ariaTools.setOnDownloadError(ariaOnDownloadError);
}

function driveUploadCompleteCallback(err: string, gid: string, url: string, filePath: string, fileName: string, fileSize: number) {
  var finalMessage;
  if (err) {
    var message = err;
    console.error(`uploadFile: Failed to upload ${gid} - ${filePath}: ${message}`);
    finalMessage = `Failed to upload <code>${fileName}</code> to Drive.${message}`;
    cleanupDownload(gid, finalMessage);
  } else {
    console.log(`Uploaded ${gid}`);
    if (fileSize) {
      var fileSizeStr = downloadUtils.formatSize(fileSize);
      finalMessage = `<a href='${url}'>${fileName}</a> (${fileSizeStr})`;
    } else {
      finalMessage = `<a href='${url}'>${fileName}</a>`;
    }
    cleanupDownload(gid, finalMessage, url);
  }
}
