import moment from 'moment'
import { indexerContainer } from '../../index'
import { HivePost } from './posts'
import { CeramicProfile, HiveProfile } from './profiles'
import { GraphQLError } from 'graphql'

export function TransformArgToMongodb(args: any) {
  if (!args) {
    return {}
  }
  let queryParams: Record<string, any> = {}
  for (let keyRaw in args) {
    const key = keyRaw as keyof typeof args
    if ((key === '_in' || key === '_nin') && !args[key]?.length) {
      continue
    }
    queryParams[(key as string).replace('_', '$')] = args[key]
  }
  return queryParams
}

function TransformNestedQuery(query: any, root_key: string): any {
  if (!query) {
    return {}
  }
  let out: Record<string, any> = {}
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('_')) {
      out[`${root_key}.${key}`] = TransformArgToMongodb(value)
    } else {
      if (out[root_key]) {
        out[root_key][key.replace('_', '$')] = value
      } else {
        out[root_key] = { [key.replace('_', '$')]: value }
      }
    }
  }
  return out
}

const gqlNameMap: Record<string, string> = {
  'byTag': 'tags',
  'byCreator': 'author',
  'byCommunity': 'parent_permlink',
  'byApp': 'app_metadata.app',
  'byType': 'app_metadata.types',
  'byLang': 'json_metadata.video.info.lang',
}


function GraphqlNameToMongo(field: keyof typeof gqlNameMap, value) {
  return {
    name: gqlNameMap[field],
    value: TransformArgToMongodb(value)
  }
}

async function TransformFeedArgs(args: any) {
  let query = {} as any

    if (args.spkvideo?.firstUpload) {
      query['app_metadata.spkvideo.first_upload'] = true
    }

    if (args.spkvideo?.only) {
      query['app_metadata.types'] = 'spkvideo'
    }

    if (args.spkvideo?.isShort) {
      query['app_metadata.spkvideo.is_short'] = true
    }

    if (args.feedOptions?.includeComments) {
      //Exclusively comments
      // query['flags'] = {
      //     $in: ['comment']
      // }
    } else {
      query['flags'] = {
        $nin: ['comment'],
      }
    }

    if (args.feedOptions?.byTag) {
      query['tags'] = TransformArgToMongodb(args.feedOptions.byTag)
    }

    if (args.feedOptions?.byCreator) {
      query['author'] = TransformArgToMongodb(args.feedOptions.byCreator)
    }

    if (args.feedOptions?.byCommunity) {
      query['parent_permlink'] = TransformArgToMongodb(args.feedOptions.byCommunity)
    }

    if (args.feedOptions?.byApp) {
      query['app_metadata.app'] = TransformArgToMongodb(args.feedOptions.byApp)
    }

    if (args.feedOptions?.byType) {
      query['app_metadata.types'] = TransformArgToMongodb(args.feedOptions.byType)
    }
    
    if (args.feedOptions?.byLang) {
      query['json_metadata.video.info.lang'] = TransformArgToMongodb(args.feedOptions.byLang)
    }

    if(args.feedOptions?._or) {
      console.log(args.feedOptions._or)
      query['$or'] = Object.entries(args.feedOptions._or).map(([key, val])=> {
        const {name, value} = GraphqlNameToMongo(key, val)
        return {
          [name]: value
        }
      })
    }

    console.log('query is ', JSON.stringify(query, null, 2))

    if (!args.feedOptions?.includeCeramic) {
      query['TYPE'] = {
        $ne: 'CERAMIC',
      }
    }

    if(args.feedOptions?.byFollower) {
      if(args.feedOptions.byFollower.startsWith('did:')) {
        const following = (await indexerContainer.self.socialConnections.find({
          follower: args.feedOptions.byFollower
        }).toArray()).map(e => {
          return e.following
        })

        query["author"] = {
          $in: following
        }
      } else {
        const following = await indexerContainer.self.followsDb.find({
          follower: args.feedOptions.byFollower
        }).toArray()

        query["author"] = {
          $in: following.map(e => e.following)
        }
      }
    }
    console.log(query)
    return query;
}

export const Resolvers = {
  async socialPost(_, args) {
    const outPut = await indexerContainer.self.posts.findOne({
      author: args.author,
      permlink: args.permlink
    })


    if(!outPut) {
      return null
    }

    return new HivePost(outPut)
  },
  async socialFeed(_, args) {
    const query = await TransformFeedArgs(args)


    // console.log(JSON.stringify(query), query)
    // console.log(, args)
    const outPut = await indexerContainer.self.posts
      .find(
        {
          ...query,
          // TYPE: { $ne: 'CERAMIC' },
        },
        {
          limit: args.pagination?.limit || 100,
          skip: args.pagination?.skip, 
          sort: {
            created_at: -1,
          },
        },
      )
      .toArray()
    return {
      items: outPut.map((e) => {
        e['__typename'] = 'HivePost'
        return new HivePost(e)
      }),
    }
  },
  async searchFeed(_, args) {
    const query = await TransformFeedArgs(args)


    // console.log(JSON.stringify(query), query)
    // console.log(, args)
    const outPut = await indexerContainer.self.posts
      .find(
        {
          ['$text']: {
            $search: args.searchTerm
          },
          ...query,
          // TYPE: { $ne: 'CERAMIC' },
        },
        {
          limit: args.pagination?.limit || 100,
          skip: args.pagination?.skip, 
          sort: {
            created_at: -1,
          },
        },
      )
      .toArray()
    return {
      items: outPut.map((e) => {
        e['__typename'] = 'HivePost'
        return new HivePost(e)
      }),
    }
  },
  async trendingFeed(_, args){
    const query = await TransformFeedArgs(args)

    const latestPost = await indexerContainer.self.posts.findOne({
      ...query,
      // TYPE: { $ne: 'CERAMIC' },
    }, {
      sort: {
        created_at: -1
      }
    })

    let sortBy;
    if(args.trendingBy === "PAYOUT") {
      sortBy = 'stats.total_hive_reward'
    } else {
      sortBy = 'stats.num_comments'
    }

    const outPut = await indexerContainer.self.posts
      .find(
        {
          ...query,
          // TYPE: { $ne: 'CERAMIC' },
          created_at: {
            $gt: moment(latestPost?.created_at || new Date()).subtract('3', 'days').toDate()
          }
        },
        {
          limit: args.pagination?.limit || 100,
          skip: args.pagination?.skip,
          sort: {
            [sortBy]: -1
          },
        },
      )
      .toArray()
      return {
        items: outPut.map((e) => {
          e['__typename'] = 'HivePost'
          return new HivePost(e)
        }),
      }
  },
  async relatedFeed(_, args) {
    const query = await TransformFeedArgs(args)
    
    const postContent = await indexerContainer.self.posts.findOne({
      permlink: args.permlink,
      author: args.author
    });

    if(!postContent) {
      throw new GraphQLError('Post does not exist or is not indexed')
    }

    let OrQuery = []

    OrQuery.push({
      ...query,
      tags: {$in: postContent.tags} 
    })
    
    if(postContent.parent_author === "") {
      OrQuery.push({
        ...query,
        parent_permlink: postContent.parent_permlink
      })
    }
    
    const items = await indexerContainer.self.posts.aggregate([{
      $match: {
        $or: OrQuery        
      },
    }, {
      $sample: {
        size: args.pagination?.limit || 25
      }
    }]).toArray()

    return {
      items: items.map(e => new HivePost(e))
    }
  },
  async profile(_, args) {
    if(args.id.startsWith('did')) {
      return await CeramicProfile.run({
        id: args.id
      })
    }
    if(args.id || args.username) {
      return await HiveProfile.run({
          username: args.id || args.username
      })   
    }

    return null
  },
  async follows(_, args) {
    const followingResult = await indexerContainer.self.followsDb.find({
      follower: args.id
    }).toArray()
    const followersResult = await indexerContainer.self.followsDb.find({
      following: args.id
    }).toArray()

    return {
      followers: followersResult.map(e => ({...e, followed_at: e.followed_at.toISOString(), 
        follower_profile: async () => Resolvers.profile(_, {username: e.follower}),
        following_profile: async () => Resolvers.profile(_, {username: e.following})
      })),
      followers_count: async () => {
        return await indexerContainer.self.followsDb.countDocuments({
          following: args.id
        })
      },
      followings: followingResult.map(e => ({
        ...e, followed_at: e.followed_at.toISOString(), 
        follower_profile: async () => {console.log('HLELO', await Resolvers.profile(_, {username: e.follower})); return await Resolvers.profile(_, {username: e.follower})},
        following_profile: async () => Resolvers.profile(_, {username: e.following})
      })),
      followings_count: async () => {
        return await indexerContainer.self.followsDb.countDocuments({
          follower: args.id
        })
      },
    }
  },
  async syncState() {
    const currentStats = await indexerContainer.self.stats.findOne({
      key: "stats"
    })

    return {
      blockLag: currentStats.blockLag,
      syncEtaSeconds: currentStats.syncEtaSeconds,
      latestBlockLagDiff: currentStats.blockLagDiff,
    }
  },
  async trendingTags(_, args: any) {
    const tagsQuery = await indexerContainer.self.posts.aggregate([
      {
        '$match': {
          'created_at': {
            $gt: moment().subtract('14', 'day').toDate()
          }
        }
      }, {
        '$unwind': {
          'path': '$tags', 
          'includeArrayIndex': 'string', 
          'preserveNullAndEmptyArrays': false
        }
      }, {
        '$group': {
          '_id': '$tags', 
          'score': {
            '$sum': 1
          }
        }
      }, {
        '$sort': {
          'score': -1
        }
      },
      {
        $limit: args.limit || 5
      },
      {
        $project: {
          _id: 0,
          "tag": "$_id",
          score: "$score"
        }
      }
    ])
    const tags = await tagsQuery.toArray();

    return {
      tags
    }
  },
  async community(_, args) {
    const community = await indexerContainer.self.communityDb.findOne({
        _id: `hive/${args.id}`
    })
    if(!community) {
      return null;
    }
    const roles = community?.roles?.map(e => {
      const [username, role, title] = e;
      return {
        username, 
        role, 
        title
      }
    })
    return {
      ...community,
      roles,
      created_at: community?.created_at?.toISOString(),
      latestFeed: async (args2) => {

        if(!args2['feedOptions']) {
          args2['feedOptions'] = {}
        }

        args2['feedOptions']['byCommunity'] = {
          _eq: args.id
        }


        return await Resolvers.socialFeed(_, args2)
      },
      trendingFeed: async (args2) => {

        if(!args2['feedOptions']) {
          args2['feedOptions'] = {}
        }

        args2['feedOptions']['byCommunity'] = {
          _eq: args.id
        }

        


        return await Resolvers.trendingFeed(_, args2)
      },
    }
  },
  async leaderBoard() {
    const activeProfiles = await indexerContainer.self.profileDb.find({
        score: {$gt: 0}
    }, {
        sort: {
            score: -1
        }
    }).toArray()

    return {
        items: activeProfiles.map((itm, index) => {
            return {
                author: itm.username,
                author_profile: new HiveProfile(itm),
                score: itm.score,
                rank: index + 1
            }
        }),
        total_active_creators: activeProfiles.length
    }
}
}
