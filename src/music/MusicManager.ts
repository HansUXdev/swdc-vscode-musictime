import {
    PlaylistItem,
    PlayerType,
    PlayerName,
    TrackStatus,
    Track,
    CodyResponse,
    getPlaylistTracks,
    PaginationItem,
    CodyResponseType,
    createPlaylist,
    addTracksToPlaylist,
    replacePlaylistTracks,
    launchPlayer,
    PlayerDevice,
    getSpotifyPlaylist,
    followPlaylist,
    playSpotifyDevice,
    playSpotifyTrack,
    PlayerContext,
    playSpotifyPlaylist,
    play,
    playTrackInContext,
    accessExpired,
    removeTracksFromPlaylist,
} from "cody-music";
import {
    PERSONAL_TOP_SONGS_NAME,
    PERSONAL_TOP_SONGS_PLID,
    SPOTIFY_LIKED_SONGS_PLAYLIST_NAME,
    SOFTWARE_TOP_40_PLAYLIST_ID,
    SHOW_ITUNES_LAUNCH_BUTTON,
    OK_LABEL,
    YES_LABEL,
} from "../Constants";
import { commands, window } from "vscode";
import {
    getSlackOauth,
    getAppJwt,
    getMusicTimeUserStatus,
    populateSpotifyPlaylists,
    populateLikedSongs,
    populateSpotifyDevices,
    populateSpotifyUser,
} from "../DataController";
import {
    getItem,
    setItem,
    isMac,
    logIt,
    getCodyErrorMessage,
    createUriFromTrackId,
    createUriFromPlaylistId,
} from "../Util";
import { isResponseOk, softwareGet, softwarePost } from "../HttpClient";
import { MusicCommandManager } from "./MusicCommandManager";
import { MusicControlManager, disconnectSpotify } from "./MusicControlManager";
import { ProviderItemManager } from "./ProviderItemManager";
import {
    sortPlaylists,
    buildTracksForRecommendations,
    requiresSpotifyAccess,
    getDeviceSet,
    getDeviceId,
    showReconnectPrompt,
} from "./MusicUtil";
import { MusicDataManager } from "./MusicDataManager";
import { MusicCommandUtil } from "./MusicCommandUtil";
import { refreshRecommendations } from "./MusicRecommendationManager";
import { MusicStateManager } from "./MusicStateManager";

export class MusicManager {
    private static instance: MusicManager;

    private providerItemMgr: ProviderItemManager;
    private dataMgr: MusicDataManager;

    private constructor() {
        this.providerItemMgr = ProviderItemManager.getInstance();
        this.dataMgr = MusicDataManager.getInstance();
    }
    static getInstance(): MusicManager {
        if (!MusicManager.instance) {
            MusicManager.instance = new MusicManager();
        }

        return MusicManager.instance;
    }

    get currentPlaylists(): PlaylistItem[] {
        if (this.dataMgr.currentPlayerName === PlayerName.ItunesDesktop) {
            // go through each playlist and find out it's state
            if (
                this.dataMgr.itunesPlaylists &&
                this.dataMgr.itunesPlaylists.length
            ) {
                this.dataMgr.itunesPlaylists.forEach((item: PlaylistItem) => {
                    if (item.type === "playlist") {
                        this.dataMgr.playlistMap[item.id] = item;
                    }
                });
            }
            return this.dataMgr.itunesPlaylists;
        }
        if (
            this.dataMgr.spotifyPlaylists &&
            this.dataMgr.spotifyPlaylists.length
        ) {
            this.dataMgr.spotifyPlaylists.forEach((item: PlaylistItem) => {
                if (item.type === "playlist") {
                    this.dataMgr.playlistMap[item.id] = item;
                }
            });
        }
        return this.dataMgr.spotifyPlaylists;
    }

    //
    // Clear all of the playlists and tracks
    //
    clearPlaylists() {
        this.dataMgr.playlistMap = {};
        this.dataMgr.playlistTrackMap = {};
    }

    updateSort(sortAlpha) {
        if (!requiresSpotifyAccess()) {
            this.dataMgr.rawPlaylists = [...this.dataMgr.origRawPlaylistOrder];
            this.dataMgr.sortAlphabetically = sortAlpha;
            commands.executeCommand("musictime.refreshPlaylist");
        }
    }

    async refreshPlaylists() {
        if (this.dataMgr.buildingPlaylists) {
            return;
        }
        this.dataMgr.buildingPlaylists = true;

        if (this.dataMgr.currentPlayerName === PlayerName.ItunesDesktop) {
            await this.refreshPlaylistForPlayer();
        } else {
            await this.refreshPlaylistForPlayer();
        }
        await MusicCommandManager.syncControls(this.dataMgr.runningTrack);

        this.dataMgr.buildingPlaylists = false;
    }

    getPlaylistById(playlist_id: string) {
        return this.dataMgr.playlistMap[playlist_id];
    }

    //
    // Fetch the playlist names for a specific player
    //
    private async refreshPlaylistForPlayer() {
        const playerName = this.dataMgr.currentPlayerName;
        let items: PlaylistItem[] = [];

        // states: [NOT_CONNECTED, MAC_PREMIUM, MAC_NON_PREMIUM, PC_PREMIUM, PC_NON_PREMIUM]
        const CONNECTED = !requiresSpotifyAccess() ? true : false;
        const IS_PREMIUM = this.isSpotifyPremium() ? true : false;
        let HAS_SPOTIFY_USER = this.hasSpotifyUser() ? true : false;

        const type =
            playerName === PlayerName.ItunesDesktop ? "itunes" : "spotify";

        // ! very important !
        // We need the spotify user if we're connected
        if (CONNECTED && !HAS_SPOTIFY_USER) {
            // get it
            await populateSpotifyUser();
        }

        // ! most important part !
        let playlists: PlaylistItem[] = this.dataMgr.rawPlaylists || [];
        let hasPlaylists = playlists.length ? true : false;
        let hasLikedSongs: boolean =
            this.dataMgr.spotifyLikedSongs &&
                this.dataMgr.spotifyLikedSongs.length
                ? true
                : false;

        // fetch the playlists
        if (!hasPlaylists && CONNECTED) {
            await populateSpotifyPlaylists();
            playlists = this.dataMgr.rawPlaylists;
            hasPlaylists = playlists.length > 0 ? true : false;
        }

        if (!hasLikedSongs && CONNECTED) {
            await populateLikedSongs();
        }

        // sort
        if (this.dataMgr.sortAlphabetically) {
            sortPlaylists(playlists);
        }

        // update each playlist itemType and tag
        if (hasPlaylists) {
            playlists.forEach((playlist) => {
                this.dataMgr.playlistMap[playlist.id] = playlist;
                playlist.itemType = "playlist";
                playlist.tag = type;
            });
        }

        // show the spotify connect premium button if they're connected and a non-premium account
        if (CONNECTED && !IS_PREMIUM) {
            // show the spotify premium account required button
            items.push(
                this.providerItemMgr.getSpotifyPremiumAccountRequiredButton()
            );
        }

        // add the connect to spotify if they still need to connect
        if (!CONNECTED) {
            items.push(this.providerItemMgr.getConnectToSpotifyButton());
        }

        if (CONNECTED) {
            items.push(this.providerItemMgr.getGenerateDashboardButton());
            items.push(this.providerItemMgr.getWebAnalyticsButton());
        }

        // add the readme button
        items.push(this.providerItemMgr.getReadmeButton());

        if (playerName === PlayerName.ItunesDesktop) {
            // add the action items specific to itunes
            items.push(this.providerItemMgr.getSwitchToSpotifyButton());

            if (playlists.length > 0) {
                items.push(this.providerItemMgr.getLineBreakButton());
            }

            playlists.forEach((item) => {
                items.push(item);
            });

            this.dataMgr.itunesPlaylists = items;
        } else {
            // check to see if they have this device available, if not, show a button
            // to switch to this device
            const switchToThisDeviceButton = await this.providerItemMgr.getSwitchToThisDeviceButton();
            if (switchToThisDeviceButton) {
                // add it
                items.push(switchToThisDeviceButton);
            }

            // show the devices button
            if (CONNECTED) {
                const devicesButton = await this.providerItemMgr.getActiveSpotifyDevicesButton();
                items.push(devicesButton);
            }

            if (isMac() && SHOW_ITUNES_LAUNCH_BUTTON) {
                items.push(this.providerItemMgr.getSwitchToItunesButton());
            }

            // add the rest only if they don't need spotify access
            if (CONNECTED || hasPlaylists) {
                // line break between actions and software playlist section
                items.push(this.providerItemMgr.getLineBreakButton());

                // get the custom playlist button
                const customPlaylistButton: PlaylistItem = this.providerItemMgr.getCustomPlaylistButton();
                if (customPlaylistButton) {
                    items.push(customPlaylistButton);
                }

                // get the Software Top 40 Playlist and add it to the playlist
                const softwareTop40: PlaylistItem = await this.getSoftwareTop40(
                    playlists
                );
                if (softwareTop40) {
                    // add it to music time playlist
                    items.push(softwareTop40);
                }

                // Add the AI generated playlist
                const aiPlaylist: PlaylistItem = this.dataMgr.getAiTopFortyPlaylist();
                if (aiPlaylist) {
                    items.push(aiPlaylist);
                }

                // LIKED SONGS folder
                // get the folder
                const likedSongsPlaylist = this.providerItemMgr.getSpotifyLikedPlaylistFolder();
                this.dataMgr.playlistMap[
                    likedSongsPlaylist.id
                ] = likedSongsPlaylist;
                items.push(likedSongsPlaylist);

                // build tracks for recommendations if none found
                const hasTracksForRecs =
                    this.dataMgr.trackIdsForRecommendations &&
                        this.dataMgr.trackIdsForRecommendations.length
                        ? true
                        : false;
                if (!hasTracksForRecs) {
                    await buildTracksForRecommendations(playlists);
                    // only refresh recommendations if we need to build them
                    refreshRecommendations();
                }

                // line break between software playlist section and normal playlists
                if (playlists.length > 0) {
                    items.push(this.providerItemMgr.getLineBreakButton());
                }

                // build the set of playlists that are not the ai, top 40, and liked songs
                playlists.forEach((item: PlaylistItem) => {
                    // add all playlists except for the software top 40.
                    // this one will get displayed in the top section
                    if (item.id !== SOFTWARE_TOP_40_PLAYLIST_ID) {
                        items.push(item);
                    } else if (softwareTop40) {
                        // set the top 40 playlist to loved
                        softwareTop40.loved = true;
                    }
                });
            }

            this.dataMgr.spotifyPlaylists = items;
        }

        this.dataMgr.ready = true;
    }

    async getSoftwareTop40(playlists): Promise<PlaylistItem> {
        // get the Software Top 40 Playlist
        let softwareTop40: PlaylistItem = playlists.find(
            (n) => n.id === SOFTWARE_TOP_40_PLAYLIST_ID
        );
        if (!softwareTop40) {
            softwareTop40 = await getSpotifyPlaylist(
                SOFTWARE_TOP_40_PLAYLIST_ID
            );
        }
        if (softwareTop40 && softwareTop40.id) {
            softwareTop40.loved = false;
            softwareTop40.itemType = "playlist";
            softwareTop40.tag = "paw";
        }
        return softwareTop40;
    }

    //
    // Fetch the playlist overall state
    //
    async getPlaylistState(playlist_id: string): Promise<TrackStatus> {
        let playlistState: TrackStatus = TrackStatus.NotAssigned;

        const playlistTrackItems: PlaylistItem[] = await this.getPlaylistItemTracksForPlaylistId(
            playlist_id
        );

        if (playlistTrackItems && playlistTrackItems.length > 0) {
            for (let i = 0; i < playlistTrackItems.length; i++) {
                const playlistItem: PlaylistItem = playlistTrackItems[i];
                if (playlistItem.id === this.dataMgr.runningTrack.id) {
                    return this.dataMgr.runningTrack.state;
                } else {
                    // update theis track status to not assigned to ensure it's also updated
                    playlistItem.state = TrackStatus.NotAssigned;
                }
            }
        }

        return playlistState;
    }

    clearPlaylistTracksForId(playlist_id) {
        this.dataMgr.playlistTrackMap[playlist_id] = null;
    }

    //
    // Fetch the tracks for a given playlist ID
    //
    async getPlaylistItemTracksForPlaylistId(
        playlist_id: string
    ): Promise<PlaylistItem[]> {
        let playlistItemTracks: PlaylistItem[] = this.dataMgr.playlistTrackMap[
            playlist_id
        ];

        if (!playlistItemTracks || playlistItemTracks.length === 0) {
            if (this.dataMgr.currentPlayerName === PlayerName.ItunesDesktop) {
                // get the itunes tracks based on this playlist id name
                const codyResp: CodyResponse = await getPlaylistTracks(
                    PlayerName.ItunesDesktop,
                    playlist_id
                );
                playlistItemTracks = this.getPlaylistItemTracksFromCodyResponse(
                    codyResp
                );
            } else {
                // fetch from spotify web
                if (playlist_id === SPOTIFY_LIKED_SONGS_PLAYLIST_NAME) {
                    playlistItemTracks = this.getPlaylistItemTracksFromTracks(
                        this.dataMgr.spotifyLikedSongs
                    );
                } else {
                    // get the playlist tracks from the spotify api
                    const codyResp: CodyResponse = await getPlaylistTracks(
                        PlayerName.SpotifyWeb,
                        playlist_id
                    );
                    playlistItemTracks = this.getPlaylistItemTracksFromCodyResponse(
                        codyResp
                    );
                }
            }

            // update the map
            this.dataMgr.playlistTrackMap[playlist_id] = playlistItemTracks;
        }

        if (playlistItemTracks && playlistItemTracks.length > 0) {
            for (let i = 0; i < playlistItemTracks.length; i++) {
                const track: PlaylistItem = playlistItemTracks[i];
                // check to see if this track is the current track
                if (this.dataMgr.runningTrack.id === track.id) {
                    playlistItemTracks[
                        i
                    ].state = this.dataMgr.runningTrack.state;
                } else {
                    playlistItemTracks[i].state = TrackStatus.NotAssigned;
                }
                playlistItemTracks[i]["playlist_id"] = playlist_id;
            }
        }

        return playlistItemTracks;
    }

    //
    // Build the playlist items from the list of tracks
    //
    getPlaylistItemTracksFromTracks(tracks: Track[]): PlaylistItem[] {
        let playlistItems: PlaylistItem[] = [];
        if (tracks && tracks.length > 0) {
            for (let i = 0; i < tracks.length; i++) {
                let track = tracks[i];
                const position = i + 1;
                let playlistItem: PlaylistItem = this.createPlaylistItemFromTrack(
                    track,
                    position
                );
                playlistItems.push(playlistItem);
            }
        }
        return playlistItems;
    }

    getPlaylistItemTracksFromCodyResponse(
        codyResponse: CodyResponse
    ): PlaylistItem[] {
        let playlistItems: PlaylistItem[] = [];
        if (codyResponse && codyResponse.state === CodyResponseType.Success) {
            let paginationItem: PaginationItem = codyResponse.data;

            if (paginationItem && paginationItem.items) {
                playlistItems = paginationItem.items.map(
                    (track: Track, idx: number) => {
                        const position = idx + 1;
                        let playlistItem: PlaylistItem = this.createPlaylistItemFromTrack(
                            track,
                            position
                        );

                        return playlistItem;
                    }
                );
            }
        }

        return playlistItems;
    }

    getArtist(track: any) {
        if (!track) {
            return null;
        }
        if (track.artist) {
            return track.artist;
        }
        if (track.artists && track.artists.length > 0) {
            const trackArtist = track.artists[0];
            return trackArtist.name;
        }
        return null;
    }

    createPlaylistItemFromTrack(track: Track, position: number) {
        const popularity = track.popularity ? track.popularity : null;
        const artistName = this.getArtist(track);

        let tooltip = track.name;
        if (artistName) {
            tooltip += ` - ${artistName}`;
        }
        if (popularity) {
            tooltip += ` (Popularity: ${popularity})`;
        }

        let playlistItem: PlaylistItem = new PlaylistItem();
        playlistItem.type = "track";
        playlistItem.name = track.name;
        playlistItem.tooltip = tooltip;
        playlistItem.id = track.id;
        playlistItem.uri = track.uri;
        playlistItem.popularity = track.popularity;
        playlistItem.position = position;
        playlistItem.artist = artistName;
        playlistItem.playerType = track.playerType;
        playlistItem.itemType = "track";
        playlistItem["icon"] = "track.svg";

        delete playlistItem.tracks;

        if (track.id === this.dataMgr.runningTrack.id) {
            playlistItem.state = this.dataMgr.runningTrack.state;
            this.dataMgr.selectedTrackItem = playlistItem;
        } else {
            playlistItem.state = TrackStatus.NotAssigned;
        }
        return playlistItem;
    }

    async playNextLikedSong() {
        const isPremiumUser = MusicManager.getInstance().isSpotifyPremium();
        const deviceId = getDeviceId();

        // play the next song
        const nextTrack: Track = this.getNextSpotifyLikedSong();
        if (nextTrack) {
            let playlistItem: PlaylistItem = this.createPlaylistItemFromTrack(
                nextTrack,
                0
            );
            this.dataMgr.selectedTrackItem = playlistItem;
            if (isPremiumUser) {
                // play the next track
                await MusicCommandUtil.getInstance().runSpotifyCommand(
                    playSpotifyTrack,
                    [playlistItem.id, deviceId]
                );
            } else {
                // play it using the track id
                const trackUri = createUriFromTrackId(playlistItem.id);
                const params = [trackUri];
                await playTrackInContext(PlayerName.SpotifyDesktop, params);
            }
        }
    }

    async playPreviousLikedSong() {
        const isPremiumUser = MusicManager.getInstance().isSpotifyPremium();
        const deviceId = getDeviceId();
        // play the next song
        const prevTrack: Track = this.getPreviousSpotifyLikedSong();
        if (prevTrack) {
            let playlistItem: PlaylistItem = this.createPlaylistItemFromTrack(
                prevTrack,
                0
            );
            this.dataMgr.selectedTrackItem = playlistItem;
            if (isPremiumUser) {
                // launch and play the next track
                await MusicCommandUtil.getInstance().runSpotifyCommand(
                    playSpotifyTrack,
                    [playlistItem.id, deviceId]
                );
            } else {
                // play it using the track id
                const trackUri = createUriFromTrackId(playlistItem.id);
                const params = [trackUri];
                await playTrackInContext(PlayerName.SpotifyDesktop, params);
            }
        }
    }

    /**
     * Return the next Spotify Track from the Liked Songs list.
     * It will return null if the Liked Songs list doesn't exist or the current track ID is not assigned.
     * It will return the 1st track if the current track ID is not assigned and the Liked Songs list exists.
     */
    getNextSpotifyLikedSong(): Track {
        const currentTrackId = this.dataMgr.selectedTrackItem.id;
        const hasLikedSongs =
            this.dataMgr.spotifyLikedSongs &&
            this.dataMgr.spotifyLikedSongs.length > 0;
        if (currentTrackId && hasLikedSongs) {
            let currTrackIndex = this.dataMgr.spotifyLikedSongs.findIndex(
                (i) => i.id === currentTrackId
            );
            if (currTrackIndex !== -1) {
                // if the curr track index is the last element, return zero, else return the next one
                if (
                    currTrackIndex + 1 <
                    this.dataMgr.spotifyLikedSongs.length
                ) {
                    return this.dataMgr.spotifyLikedSongs[currTrackIndex + 1];
                } else {
                    return this.dataMgr.spotifyLikedSongs[0];
                }
            }
        } else if (!currentTrackId && hasLikedSongs) {
            return this.dataMgr.spotifyLikedSongs[0];
        }
        return null;
    }

    getPreviousSpotifyLikedSong(): Track {
        const currentTrackId = this.dataMgr.selectedTrackItem.id;
        const hasLikedSongs =
            this.dataMgr.spotifyLikedSongs &&
            this.dataMgr.spotifyLikedSongs.length > 0;
        if (currentTrackId && hasLikedSongs) {
            const currTrackIndex = this.dataMgr.spotifyLikedSongs.findIndex(
                (i) => i.id === currentTrackId
            );
            if (currTrackIndex !== -1) {
                // if the curr track index is the last element, return zero, else return the next one
                if (currTrackIndex - 1 >= 0) {
                    return this.dataMgr.spotifyLikedSongs[currTrackIndex - 1];
                } else {
                    return this.dataMgr.spotifyLikedSongs[
                        this.dataMgr.spotifyLikedSongs.length - 1
                    ];
                }
            }
        }
        return null;
    }

    /**
     * These are the top productivity songs for this user
     */
    async syncUsersWeeklyTopSongs() {
        const response = await softwareGet(
            "/music/recommendations?limit=40",
            getItem("jwt")
        );

        if (isResponseOk(response) && response.data.length > 0) {
            this.dataMgr.userTopSongs = response.data;
        } else {
            // clear the favorites
            this.dataMgr.userTopSongs = [];
        }
    }

    async generateUsersWeeklyTopSongs() {
        if (this.dataMgr.buildingCustomPlaylist) {
            return;
        }

        if (requiresSpotifyAccess()) {
            // don't create or refresh, no spotify access provided
            return;
        }

        this.dataMgr.buildingCustomPlaylist = true;

        let customPlaylist: PlaylistItem = this.dataMgr.getMusicTimePlaylistByTypeId(
            PERSONAL_TOP_SONGS_PLID
        );

        const infoMsg = !customPlaylist
            ? `Creating and populating the ${PERSONAL_TOP_SONGS_NAME} playlist, please wait.`
            : `Refreshing the ${PERSONAL_TOP_SONGS_NAME} playlist, please wait.`;

        window.showInformationMessage(infoMsg);

        let playlistId = null;
        if (!customPlaylist) {
            const playlistResult: CodyResponse = await createPlaylist(
                PERSONAL_TOP_SONGS_NAME,
                true
            );

            const errMsg = getCodyErrorMessage(playlistResult);
            if (errMsg) {
                window.showErrorMessage(
                    `There was an unexpected error adding tracks to the playlist. ${errMsg} Refresh the playlist and try again if you feel the problem has been resolved.`,
                    ...[OK_LABEL]
                );
                this.dataMgr.buildingCustomPlaylist = false;
                return;
            }

            playlistId = playlistResult.data.id;

            await this.updateSavedPlaylists(
                playlistId,
                PERSONAL_TOP_SONGS_PLID,
                PERSONAL_TOP_SONGS_NAME
            ).catch((err) => {
                logIt("Error updating music time with generated playlist ID");
            });
        } else {
            // get the spotify playlist id from the app's existing playlist info
            playlistId = customPlaylist.id;
        }

        // get the spotify track ids and create the playlist
        if (playlistId) {
            // sync the user's weekly top songs
            await this.syncUsersWeeklyTopSongs();

            // add the tracks
            // list of [{trackId, artist, name}...]
            if (
                this.dataMgr.userTopSongs &&
                this.dataMgr.userTopSongs.length > 0
            ) {
                let tracksToAdd: string[] = this.dataMgr.userTopSongs.map(
                    (item) => {
                        if (item.uri) {
                            return item.uri;
                        } else if (item.trackId) {
                            return item.trackId;
                        }
                        return item.id;
                    }
                );

                if (!customPlaylist) {
                    await this.addTracks(
                        playlistId,
                        PERSONAL_TOP_SONGS_NAME,
                        tracksToAdd
                    );
                } else {
                    await replacePlaylistTracks(playlistId, tracksToAdd).catch(
                        (err) => {
                            logIt(`Error replacing tracks: ${err.message}`);
                        }
                    );

                    window.showInformationMessage(
                        `Successfully refreshed ${PERSONAL_TOP_SONGS_NAME}.`
                    );
                }
            } else {
                window.showInformationMessage(
                    `Successfully created ${PERSONAL_TOP_SONGS_NAME}, but we're unable to add any songs at the moment.`,
                    ...[OK_LABEL]
                );
            }
        }

        // repopulate the spotify playlists
        await populateSpotifyPlaylists();

        commands.executeCommand("musictime.refreshPlaylist");

        // update building custom playlist to false
        this.dataMgr.buildingCustomPlaylist = false;
    }

    async addTracks(playlist_id: string, name: string, tracksToAdd: string[]) {
        if (playlist_id) {
            // create the playlist_id in software
            const addTracksResult: CodyResponse = await addTracksToPlaylist(
                playlist_id,
                tracksToAdd
            );

            if (addTracksResult.state === CodyResponseType.Success) {
                window.showInformationMessage(
                    `Successfully created ${name} and added tracks.`
                );
            } else {
                window.showErrorMessage(
                    `There was an unexpected error adding tracks to the playlist. ${addTracksResult.message}`,
                    ...[OK_LABEL]
                );
            }
        }
    }

    async updateSavedPlaylists(
        playlist_id: string,
        playlistTypeId: number,
        name: string
    ) {
        // playlistTypeId 1 = personal custom top 40
        const payload = {
            playlist_id,
            playlistTypeId,
            name,
        };
        let jwt = getItem("jwt");
        let createResult = await softwarePost(
            "/music/playlist/generated",
            payload,
            jwt
        );

        return createResult;
    }

    async initializeSlack() {
        const slackOauth = await getSlackOauth();
        if (slackOauth) {
            // update the CodyMusic credentials
            this.updateSlackAccessInfo(slackOauth);
        } else {
            setItem("slack_access_token", null);
        }
    }

    async updateSlackAccessInfo(slackOauth) {
        /**
         * {access_token, refresh_token}
         */
        if (slackOauth) {
            setItem("slack_access_token", slackOauth.access_token);
        } else {
            setItem("slack_access_token", null);
        }
    }

    async updateSpotifyAccessInfo(spotifyOauth) {
        if (spotifyOauth && spotifyOauth.access_token) {
            // update the CodyMusic credentials
            setItem("spotify_access_token", spotifyOauth.access_token);
            setItem("spotify_refresh_token", spotifyOauth.refresh_token);
            setItem("requiresSpotifyReAuth", false);
            // update cody config
            this.dataMgr.updateCodyConfig();
        } else {
            setItem("spotify_access_token", null);
            setItem("spotify_refresh_token", null);
            setItem("requiresSpotifyReAuth", true);
            // update cody config
            this.dataMgr.updateCodyConfig();
            // update the spotify user to null
            this.dataMgr.spotifyUser = null;
        }
    }

    async initializeSpotify() {
        // get the client id and secret
        let clientId = "";
        let clientSecret = "";

        let jwt = getItem("jwt");
        if (!jwt) {
            jwt = await getAppJwt();
        }
        const resp = await softwareGet("/auth/spotify/clientInfo", jwt);
        if (isResponseOk(resp)) {
            // get the clientId and clientSecret
            clientId = resp.data.clientId;
            clientSecret = resp.data.clientSecret;
        }

        this.dataMgr.spotifyClientId = clientId;
        this.dataMgr.spotifyClientSecret = clientSecret;
        this.dataMgr.updateCodyConfig();

        // update the user info
        if (requiresSpotifyAccess()) {
            await getMusicTimeUserStatus();
        } else {
            // this should only be done after we've updated the cody config
            const requiresReAuth = await this.requiresReAuthentication();
            if (requiresReAuth) {
                const email = getItem("name");

                // remove their current spotify info and initiate the auth flow
                await disconnectSpotify(false /*confirmDisconnect*/);

                showReconnectPrompt(email);
            } else {
                // initialize the user and devices
                await populateSpotifyUser();
                setTimeout(() => {
                    // populate spotify devices lazily
                    populateSpotifyDevices();
                }, 2000);
            }
        }

        // initialize the status bar music controls
        MusicCommandManager.initialize();
    }

    async requiresReAuthentication(): Promise<boolean> {
        const checkedSpotifyAccess = getItem("vscode_checkedSpotifyAccess");
        const hasAccessToken = getItem("spotify_access_token");
        if (!checkedSpotifyAccess && hasAccessToken) {
            const expired = await accessExpired();

            if (expired) {
                setItem("requiresSpotifyReAuth", true);
            }

            setItem("vscode_checkedSpotifyAccess", true);
            return expired;
        }
        return false;
    }

    async launchTrackPlayer(
        playerName: PlayerName = null,
        callback: any = null
    ) {
        const {
            webPlayer,
            desktop,
            activeDevice,
            activeComputerDevice,
            activeWebPlayerDevice,
            activeDesktopPlayerDevice,
        } = getDeviceSet();

        const isPremiumUser = MusicManager.getInstance().isSpotifyPremium();
        const isMacUser = isMac();

        const hasDesktopDevice =
            activeDesktopPlayerDevice || desktop ? true : false;

        const requiresDesktopLaunch =
            !isPremiumUser && isMac() && !hasDesktopDevice ? true : false;

        if (requiresDesktopLaunch && playerName !== PlayerName.SpotifyDesktop) {
            window.showInformationMessage(
                "Launching Spotify desktop instead of the web player to allow playback as a non-premium account"
            );
        }

        if (requiresDesktopLaunch || playerName === PlayerName.SpotifyDesktop) {
            playerName = PlayerName.SpotifyDesktop;
        } else {
            playerName = PlayerName.SpotifyWeb;
        }

        // {playlist_id | album_id | track_id, quietly }
        const options = {
            quietly: false,
        };

        const hasSelectedTrackItem =
            this.dataMgr.selectedTrackItem && this.dataMgr.selectedTrackItem.id
                ? true
                : false;
        const hasSelectedPlaylistItem =
            this.dataMgr.selectedPlaylist && this.dataMgr.selectedPlaylist.id
                ? true
                : false;

        if (
            !isPremiumUser &&
            (hasSelectedTrackItem || hasSelectedPlaylistItem)
        ) {
            // show the track or playlist
            const isRecommendationTrack =
                this.dataMgr.selectedTrackItem.type === "recommendation"
                    ? true
                    : false;
            const isLikedSong =
                this.dataMgr.selectedPlaylist &&
                    this.dataMgr.selectedPlaylist.name ===
                    SPOTIFY_LIKED_SONGS_PLAYLIST_NAME
                    ? true
                    : false;
            if (
                hasSelectedTrackItem &&
                (isRecommendationTrack || isLikedSong)
            ) {
                options["track_id"] = this.dataMgr.selectedTrackItem.id;
            } else {
                options["playlist_id"] = this.dataMgr.selectedPlaylist.id;
            }
        }

        // spotify device launch error would look like this...
        // error:"Command failed: open -a spotify\nUnable to find application named 'spotify'\n"
        const result = await launchPlayer(playerName, options);

        // test if there was an error, fallback to the web player
        if (
            playerName === PlayerName.SpotifyDesktop &&
            result &&
            result.error &&
            result.error.includes("failed")
        ) {
            // start the process of launching the web player
            playerName = PlayerName.SpotifyWeb;
            await launchPlayer(playerName, options);
        }

        setTimeout(() => {
            this.checkDeviceLaunch(playerName, 7, callback);
        }, 1500);
    }

    async checkDeviceLaunch(
        playerName: PlayerName,
        tries: number = 5,
        callback: any = null
    ) {
        setTimeout(async () => {
            await populateSpotifyDevices(true);
            const devices = this.dataMgr.currentDevices;
            if ((!devices || devices.length == 0) && tries > 0) {
                tries--;
                this.checkDeviceLaunch(playerName, tries, callback);
            } else {

                const deviceId = getDeviceId();
                if (!deviceId && !isMac()) {
                    window.showInformationMessage(
                        "Unable to detect a connected Spotify device. Please make sure you are logged into your account."
                    );
                }

                commands.executeCommand("musictime.refreshDeviceInfo");

                if (callback) {
                    setTimeout(async () => {
                        callback();
                    }, 1000);
                }
            }
        }, 2000);
    }

    async isLikedSong() {
        const playlistId = this.dataMgr.selectedPlaylist
            ? this.dataMgr.selectedPlaylist.id
            : null;
        const isLikedSong =
            playlistId === SPOTIFY_LIKED_SONGS_PLAYLIST_NAME ? true : false;
        return isLikedSong;
    }

    isMacDesktopEnabled() {
        const {
            webPlayer,
            desktop,
            activeDevice,
            activeComputerDevice,
            activeWebPlayerDevice,
            activeDesktopPlayerDevice,
        } = getDeviceSet();
        return isMac() && (desktop || activeDesktopPlayerDevice) ? true : false;
    }

    hasSpotifyUser() {
        return this.dataMgr.spotifyUser && this.dataMgr.spotifyUser.product
            ? true
            : false;
    }

    isSpotifyPremium() {
        return this.hasSpotifyUser() &&
            this.dataMgr.spotifyUser.product === "premium"
            ? true
            : false;
    }

    getPlayerNameForPlayback() {
        // if you're offline you may still have spotify desktop player abilities.
        // check if the current player is spotify and we don't have web access.
        // if no web access, then use the desktop player
        if (
            this.dataMgr.currentPlayerName !== PlayerName.ItunesDesktop &&
            isMac() &&
            !this.isSpotifyPremium()
        ) {
            return PlayerName.SpotifyDesktop;
        }
        return this.dataMgr.currentPlayerName;
    }

    async showPlayerLaunchConfirmation(callback: any = null) {
        // if they're a mac non-premium user, just launch the desktop player
        const isPremiumUser = MusicManager.getInstance().isSpotifyPremium();
        if (isMac() && !isPremiumUser) {
            return this.launchTrackPlayer(PlayerName.SpotifyDesktop, callback);
        } else {
            const buttons = ["Web Player", "Desktop Player"];

            // no devices found at all OR no active devices and a computer device is not found in the list
            const selectedButton = await window.showInformationMessage(
                `Music Time requires a running Spotify player. Choose a player to launch.`,
                ...buttons
            );

            if (
                selectedButton === "Desktop Player" ||
                selectedButton === "Web Player"
            ) {
                const playerName: PlayerName =
                    selectedButton === "Desktop Player"
                        ? PlayerName.SpotifyDesktop
                        : PlayerName.SpotifyWeb;
                // start the launch process and pass the callback when complete
                return this.launchTrackPlayer(playerName, callback);
            }
        }
        return;
    }

    async playInitialization(callback: any = null) {
        const devices: PlayerDevice[] = this.dataMgr.currentDevices;

        const {
            webPlayer,
            desktop,
            activeDevice,
            activeComputerDevice,
            activeWebPlayerDevice,
            activeDesktopPlayerDevice,
        } = getDeviceSet();

        let hasSpotifyUser = MusicManager.getInstance().hasSpotifyUser();
        if (!hasSpotifyUser) {
            // try again
            await populateSpotifyUser();
            hasSpotifyUser = MusicManager.getInstance().hasSpotifyUser();
        }

        const hasDesktopLaunched =
            desktop || activeDesktopPlayerDevice ? true : false;

        const hasDesktopOrWebLaunched =
            hasDesktopLaunched || webPlayer || activeWebPlayerDevice
                ? true
                : false;
        const isPremiumUser = MusicManager.getInstance().isSpotifyPremium();

        const requiresDesktopLaunch =
            !isPremiumUser && isMac() && !hasDesktopLaunched ? true : false;

        if (!hasDesktopOrWebLaunched || requiresDesktopLaunch) {
            return await this.showPlayerLaunchConfirmation(callback);
        }

        // we have a device, continue to the callback if we have it
        if (callback) {
            callback();
        }
    }

    async followSpotifyPlaylist(playlist: PlaylistItem) {
        const codyResp: CodyResponse = await followPlaylist(playlist.id);
        if (codyResp.state === CodyResponseType.Success) {
            window.showInformationMessage(
                `Successfully following the '${playlist.name}' playlist.`
            );

            // repopulate the playlists since we've changed the state of the playlist
            await populateSpotifyPlaylists();

            commands.executeCommand("musictime.refreshPlaylist");
        } else {
            window.showInformationMessage(
                `Unable to follow ${playlist.name}. ${codyResp.message}`,
                ...[OK_LABEL]
            );
        }
    }

    async removeTrackFromPlaylist(trackItem: PlaylistItem) {
        // get the playlist it's in
        const currentPlaylistId = trackItem["playlist_id"];
        const foundPlaylist = await this.getPlaylistById(currentPlaylistId);
        if (foundPlaylist) {
            // if it's the liked songs, then send it to the setLiked(false) api
            if (foundPlaylist.id === SPOTIFY_LIKED_SONGS_PLAYLIST_NAME) {
                const buttonSelection = await window.showInformationMessage(
                    `Are you sure you would like to remove '${trackItem.name}' from your '${SPOTIFY_LIKED_SONGS_PLAYLIST_NAME}' playlist?`,
                    ...[YES_LABEL]
                );

                if (buttonSelection === YES_LABEL) {
                    let track: Track = new Track();
                    track.id = trackItem.id;
                    track.playerType = PlayerType.WebSpotify;
                    track.state = TrackStatus.NotAssigned;
                    await MusicControlManager.getInstance().setLiked(
                        false,
                        track
                    );
                    commands.executeCommand("musictime.refreshPlaylist");
                }
            } else {
                // remove it from a playlist
                const tracks = [trackItem.id];
                const result = await removeTracksFromPlaylist(
                    currentPlaylistId,
                    tracks
                );

                const errMsg = getCodyErrorMessage(result);
                if (errMsg) {
                    window.showInformationMessage(
                        `Error removing the selected track. ${errMsg}`
                    );
                } else {
                    window.showInformationMessage("Song removed successfully");
                    commands.executeCommand("musictime.refreshPlaylist");
                }
            }
        }
    }

    /**
     * Transfer to this device
     * @param computerDevice
     */
    async transferToComputerDevice(computerDevice: PlayerDevice = null) {
        const devices: PlayerDevice[] = await this.dataMgr.currentDevices;
        if (!computerDevice) {
            computerDevice =
                devices && devices.length > 0
                    ? devices.find((d) => d.type.toLowerCase() === "computer")
                    : null;
        }
        if (computerDevice) {
            await playSpotifyDevice(computerDevice.id);
        }
    }

    async isTrackRepeating(): Promise<boolean> {
        // get the current repeat state
        const spotifyContext: PlayerContext = this.dataMgr.spotifyContext;
        // "off", "track", "context", ""
        const repeatState = spotifyContext ? spotifyContext.repeat_state : "";
        return repeatState && repeatState === "track" ? true : false;
    }

    async getPlaylistTrackState(playlistId): Promise<TrackStatus> {
        let playlistItemTracks: PlaylistItem[] = this.dataMgr.playlistTrackMap[
            playlistId
        ];
        if (!playlistItemTracks || playlistItemTracks.length === 0) {
            playlistItemTracks = await this.getPlaylistItemTracksForPlaylistId(
                playlistId
            );
        }

        if (playlistItemTracks && playlistItemTracks.length > 0) {
            for (let i = 0; i < playlistItemTracks.length; i++) {
                const track: PlaylistItem = playlistItemTracks[i];
                // check to see if this track is the current track
                if (this.dataMgr.runningTrack.id === track.id) {
                    return this.dataMgr.runningTrack.state;
                }
            }
        }
        return TrackStatus.NotAssigned;
    }

    async playSelectedItem(playlistItem: PlaylistItem) {
        // set the selected track and/or playlist
        if (playlistItem.type !== "playlist") {
            this.dataMgr.selectedTrackItem = playlistItem;
            const currentPlaylistId = playlistItem["playlist_id"];
            const playlist: PlaylistItem = await this.getPlaylistById(
                currentPlaylistId
            );
            this.dataMgr.selectedPlaylist = playlist;
        } else {
            // set the selected playlist
            this.dataMgr.selectedPlaylist = playlistItem;
        }

        // ask to launch web or desktop if neither are running
        await this.playInitialization(this.playMusicSelection);
    }

    playMusicSelection = async () => {
        const musicCommandUtil: MusicCommandUtil = MusicCommandUtil.getInstance();
        // get the playlist id, track id, and device id
        const playlistId = this.dataMgr.selectedPlaylist
            ? this.dataMgr.selectedPlaylist.id
            : null;
        let trackId = this.dataMgr.selectedTrackItem
            ? this.dataMgr.selectedTrackItem.id
            : null;

        const deviceId = getDeviceId();

        const isLikedSong =
            this.dataMgr.selectedPlaylist &&
                this.dataMgr.selectedPlaylist.name ===
                SPOTIFY_LIKED_SONGS_PLAYLIST_NAME
                ? true
                : false;
        const isRecommendationTrack =
            this.dataMgr.selectedTrackItem.type === "recommendation"
                ? true
                : false;

        const isPremiumUser = MusicManager.getInstance().isSpotifyPremium();
        const useSpotifyWeb = isPremiumUser || !isMac() ? true : false;

        if (isRecommendationTrack || isLikedSong) {
            let result = null;
            if (useSpotifyWeb) {
                // it's a liked song or recommendation track play request
                result = await this.playRecommendationsOrLikedSongsByPlaylist(
                    this.dataMgr.selectedTrackItem,
                    deviceId
                );
            } else {
                // play it using applescript
                const trackUri = createUriFromTrackId(
                    this.dataMgr.selectedTrackItem.id
                );
                const params = [trackUri];
                result = await playTrackInContext(
                    PlayerName.SpotifyDesktop,
                    params
                );
            }
            await musicCommandUtil.checkIfAccessExpired(result);
        } else if (playlistId) {
            if (useSpotifyWeb) {
                // NORMAL playlist request
                // play a playlist
                await musicCommandUtil.runSpotifyCommand(playSpotifyPlaylist, [
                    playlistId,
                    trackId,
                    deviceId,
                ]);
            } else {
                // play it using applescript
                const trackUri = createUriFromTrackId(trackId);
                const playlistUri = createUriFromPlaylistId(playlistId);
                const params = [trackUri, playlistUri];
                await playTrackInContext(PlayerName.SpotifyDesktop, params);
            }
        } else {
            if (useSpotifyWeb) {
                // else it's not a liked or recommendation play request, just play the selected track
                await musicCommandUtil.runSpotifyCommand(playSpotifyTrack, [
                    trackId,
                    deviceId,
                ]);
            } else {
                // play it using applescript
                const trackUri = createUriFromTrackId(trackId);
                const params = [trackUri];
                await playTrackInContext(PlayerName.SpotifyDesktop, params);
            }
        }

        setTimeout(() => {
            MusicStateManager.getInstance().gatherMusicInfoRequest();
        }, 1000);
    };

    playRecommendationsOrLikedSongsByPlaylist = async (
        playlistItem: PlaylistItem,
        deviceId: string
    ) => {
        const trackId = playlistItem.id;
        const isRecommendationTrack =
            playlistItem.type === "recommendation" ? true : false;

        let offset = 0;
        let track_ids = [];
        if (isRecommendationTrack) {
            // RECOMMENDATION track request
            // get the offset of this track
            offset = this.dataMgr.recommendationTracks.findIndex(
                (t: Track) => trackId === t.id
            );
            // play the list of recommendation tracks
            track_ids = this.dataMgr.recommendationTracks.map(
                (t: Track) => t.id
            );

            // make it a list of 50, so get the rest from trackIdsForRecommendations
            const otherTrackIds = this.dataMgr.trackIdsForRecommendations.filter(
                (t: string) => !track_ids.includes(t)
            );
            const spliceLimit = 50 - track_ids.length;
            const addtionalTrackIds = otherTrackIds.splice(0, spliceLimit);
            track_ids.push(...addtionalTrackIds);
        } else {
            offset = this.dataMgr.spotifyLikedSongs.findIndex(
                (t: Track) => trackId === t.id
            );
            // play the list of recommendation tracks
            track_ids = this.dataMgr.spotifyLikedSongs.map((t: Track) => t.id);
            // trim it down to 50
            track_ids = track_ids.splice(0, 50);
        }

        const result: any = await MusicCommandUtil.getInstance().runSpotifyCommand(
            play,
            [
                PlayerName.SpotifyWeb,
                {
                    track_ids,
                    device_id: deviceId,
                    offset,
                },
            ]
        );

        return result;
    };
}
